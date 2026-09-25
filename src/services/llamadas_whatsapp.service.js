/**
 * Llamadas de voz por WhatsApp — fase 1: el cliente llama al negocio.
 *
 * Cómo funciona (WhatsApp Business Calling API, Cloud API):
 *   1. El cliente pulsa "llamar" en el chat de WhatsApp. Meta manda al
 *      webhook de la conexión el campo `calls` con evento `connect` y una
 *      oferta de audio (SDP). Hay 30-60 s para contestar.
 *   2. Acá se resuelve el contacto, se guarda la llamada y se le avisa por
 *      socket (namespace /presence, sala sub:<id>) al encargado del chat; si
 *      no tiene, a todo el equipo de la conexión.
 *   3. El navegador del asesor arma la conexión WebRTC con esa oferta y manda
 *      su respuesta (SDP answer). Este servicio la reenvía a Meta con
 *      `pre_accept` y, cuando el audio ya está conectado, `accept`. La
 *      primera persona que acepta se queda la llamada: al resto se le avisa
 *      quién la tomó y se les bloquea el botón.
 *   4. Colgar / rechazar van con `terminate` / `reject`. Al final Meta manda
 *      `terminate` con estado y duración: se cierra la fila y se deja una
 *      notificación en el chat (rol 3).
 *
 * El backend nunca toca el audio: solo pasa las SDP. El audio va directo
 * entre el navegador y los servidores de Meta (WebRTC, OPUS).
 *
 * Prerrequisitos por conexión: número en Cloud API con límite ≥ 2.000,
 * campo `calls` suscrito en el App Dashboard de Meta y
 * settings.calling.status = ENABLED en el número (activarLlamadas()).
 */
const axios = require('axios');
const { db } = require('../database/config');
const Configuraciones = require('../models/configuraciones.model');
const ClientesChatCenter = require('../models/clientes_chat_center.model');
const MensajesClientes = require('../models/mensaje_cliente.model');
const LlamadasWhatsapp = require('../models/llamadas_whatsapp.model');
const {
  ensureUnifiedClient,
} = require('../utils/unified/ensureUnifiedClient');
const {
  enviarConsultaAPI,
} = require('../utils/webhook_whatsapp/enviar_consulta_socket');

const GRAPH = () =>
  `https://graph.facebook.com/${process.env.GRAPH_VERSION || 'v25.0'}`;

/** Meta corta la llamada si nadie contesta en 30-60 s; se avisa un poco antes. */
const TIMBRE_MAX_MS = 45_000;

/* ── Llamadas vivas (por proceso) ──
   call_id → { id_configuracion, id_cliente, telefono, sdp_offer, estado,
               destinatarios:[id_sub_usuario], tomada_por, timer }
   Si el server se reinicia a mitad de una llamada, Meta la termina sola y
   el webhook terminate cierra la fila en BD. */
const activas = new Map();

const ax = (token) =>
  axios.create({
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    timeout: 15000,
    validateStatus: () => true,
  });

const presenceIo = () => global.presenceIo || null;

function emitirA(ids, evento, payload) {
  const io = presenceIo();
  if (!io) {
    console.error('[llamadas] sin namespace /presence: no se puede avisar', evento);
    return;
  }
  for (const id of new Set(ids.map(Number).filter(Boolean))) {
    io.to(`sub:${id}`).emit(evento, payload);
  }
  // Diagnóstico: cuántas pestañas conectadas había en cada sala. Si sale 0,
  // el asesor no tenía la app abierta (o está en otro proceso del server).
  socketsEnSala(ids)
    .then((conteo) =>
      console.log(
        `[llamadas] ${evento} → ${JSON.stringify(conteo)} (pid ${process.pid})`,
      ),
    )
    .catch(() => {});
}

/** { id_sub_usuario: sockets conectados en su sala } */
async function socketsEnSala(ids) {
  const io = presenceIo();
  const out = {};
  if (!io) return out;
  for (const id of new Set(ids.map(Number).filter(Boolean))) {
    try {
      const sockets = await io.in(`sub:${id}`).fetchSockets();
      out[id] = sockets.length;
    } catch {
      out[id] = -1;
    }
  }
  return out;
}

/** Equipo de la conexión: subusuarios de sus departamentos; si no hay
 *  departamentos, toda la cuenta. */
async function equipoDeConexion(id_configuracion, id_usuario) {
  const miembros = await db.query(
    `SELECT DISTINCT sud.id_sub_usuario
     FROM departamentos_chat_center dc
     INNER JOIN sub_usuarios_departamento sud ON sud.id_departamento = dc.id_departamento
     INNER JOIN sub_usuarios_chat_center su ON su.id_sub_usuario = sud.id_sub_usuario
     WHERE dc.id_configuracion = ? AND su.suspendido = 0`,
    { replacements: [id_configuracion], type: db.QueryTypes.SELECT },
  );
  if (miembros.length) return miembros.map((m) => Number(m.id_sub_usuario));
  const todos = await db.query(
    `SELECT id_sub_usuario FROM sub_usuarios_chat_center
     WHERE id_usuario = ? AND suspendido = 0`,
    { replacements: [id_usuario], type: db.QueryTypes.SELECT },
  );
  return todos.map((m) => Number(m.id_sub_usuario));
}

async function nombreSubUsuario(id_sub_usuario) {
  if (!id_sub_usuario) return null;
  const [su] = await db.query(
    `SELECT nombre_encargado FROM sub_usuarios_chat_center WHERE id_sub_usuario = ? LIMIT 1`,
    { replacements: [id_sub_usuario], type: db.QueryTypes.SELECT },
  );
  return su?.nombre_encargado || null;
}

/** Notificación en el chat (rol 3), igual que las transferencias. */
async function notificarEnChat(configuracion, cliente, texto) {
  if (!cliente) return;
  const propietario = await ClientesChatCenter.findOne({
    where: { id_configuracion: configuracion.id, propietario: 1 },
    attributes: ['id'],
  });
  await MensajesClientes.create({
    id_configuracion: configuracion.id,
    id_cliente: propietario?.id || null,
    mid_mensaje: configuracion.id_telefono,
    tipo_mensaje: 'notificacion',
    visto: 0,
    texto_mensaje: texto,
    rol_mensaje: 3,
    celular_recibe: cliente.id,
    uid_whatsapp: cliente.celular_cliente,
  });
  try {
    await enviarConsultaAPI(configuracion.id, cliente.id);
  } catch (e) {
    console.error('[llamadas] refresco del chat falló:', e.message);
  }
}

const fmtDuracion = (seg) => {
  const s = Number(seg) || 0;
  if (s < 60) return `${s} s`;
  return `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, '0')} s`;
};

function payloadPublico(call_id, extra = {}) {
  const c = activas.get(call_id);
  if (!c) return { call_id, ...extra };
  return {
    call_id,
    id_configuracion: c.id_configuracion,
    id_cliente_chat_center: c.id_cliente,
    telefono: c.telefono,
    nombre_cliente: c.nombre_cliente,
    estado: c.estado,
    tomada_por: c.tomada_por
      ? { id_sub_usuario: c.tomada_por, nombre: c.tomada_por_nombre }
      : null,
    inicio_at: c.inicio_at,
    ...extra,
  };
}

/* ═══════════════════════════════════════════════════════════════════════
   WEBHOOK `calls`
   ═══════════════════════════════════════════════════════════════════════ */
async function manejarWebhookLlamadas(value) {
  const business_phone_id = value?.metadata?.phone_number_id || '';
  const configuracion = await Configuraciones.findOne({
    where: { id_telefono: business_phone_id, suspendido: 0 },
  });
  if (!configuracion) {
    console.warn('[llamadas] webhook sin configuración para', business_phone_id);
    return;
  }
  for (const call of value?.calls || []) {
    try {
      if (call.event === 'connect' && call.direction === 'USER_INITIATED') {
        await llamadaEntrante(configuracion, call, value);
      } else if (call.event === 'connect') {
        // Saliente: Meta devuelve la respuesta de audio (SDP answer) del cliente.
        await salienteConectada(call);
      } else if (call.event === 'terminate') {
        await llamadaTerminada(configuracion, call);
      } else {
        // status de una saliente: RINGING / ACCEPTED / REJECTED
        await salienteEstado(call);
      }
    } catch (e) {
      console.error('[llamadas] error procesando', call?.event, call?.id, e.message);
    }
  }
}

async function salienteConectada(call) {
  const c = activas.get(call.id);
  if (!c) return;
  c.sdp_answer = call.session?.sdp || null;
  emitirA(c.destinatarios, 'LLAMADA_CONECTADA', {
    ...payloadPublico(call.id),
    sdp_answer: c.sdp_answer,
  });
}

async function salienteEstado(call) {
  const c = activas.get(call.id);
  const estado = String(call.status || call.event || '').toUpperCase();
  if (!c || !estado) {
    console.log('[llamadas] evento', call.event, call.id, call.status || '');
    return;
  }
  if (estado === 'ACCEPTED') {
    c.estado = 'accepted';
    await LlamadasWhatsapp.update(
      { estado: 'accepted', contestada_at: new Date() },
      { where: { call_id: call.id } },
    );
  } else if (estado === 'REJECTED') {
    c.estado = 'rejected_cliente';
    await LlamadasWhatsapp.update({ estado: 'rejected' }, { where: { call_id: call.id } });
  }
  emitirA(c.destinatarios, 'LLAMADA_ESTADO', payloadPublico(call.id, { status: estado }));
}

async function llamadaEntrante(configuracion, call, value) {
  const call_id = call.id;
  if (activas.has(call_id)) return; // reintento del webhook
  const telefono = String(call.from || '').trim();
  const nombreMeta = value?.contacts?.[0]?.profile?.name || '';

  const cliente = await ensureUnifiedClient({
    id_configuracion: configuracion.id,
    id_usuario_dueno: configuracion.id_usuario,
    source: 'wa',
    business_phone_id: configuracion.id_telefono,
    phone: telefono,
    nombre_cliente: nombreMeta,
    motivo: 'llamada_whatsapp',
    permiso_round_robin: configuracion.permiso_round_robin,
  });

  // Al encargado del chat; si no tiene, o ya no existe / está suspendido
  // (pasa con contactos viejos), a todo el equipo de la conexión.
  let destinatarios = [];
  if (cliente?.id_encargado) {
    const [enc] = await db.query(
      `SELECT id_sub_usuario FROM sub_usuarios_chat_center
       WHERE id_sub_usuario = ? AND suspendido = 0 LIMIT 1`,
      { replacements: [cliente.id_encargado], type: db.QueryTypes.SELECT },
    );
    if (enc) destinatarios = [Number(enc.id_sub_usuario)];
  }
  if (!destinatarios.length) {
    destinatarios = await equipoDeConexion(configuracion.id, configuracion.id_usuario);
  }

  const inicio_at = new Date();
  await LlamadasWhatsapp.create({
    call_id,
    id_configuracion: configuracion.id,
    id_cliente_chat_center: cliente?.id || null,
    direccion: 'USER_INITIATED',
    telefono_cliente: telefono,
    estado: 'ringing',
    inicio_at,
  }).catch((e) => {
    if (!/Duplicate/i.test(e.message)) throw e;
  });

  const registro = {
    id_configuracion: configuracion.id,
    id_usuario: configuracion.id_usuario,
    id_cliente: cliente?.id || null,
    telefono,
    nombre_cliente:
      `${cliente?.nombre_cliente || ''} ${cliente?.apellido_cliente || ''}`.trim() ||
      nombreMeta ||
      telefono,
    sdp_offer: call.session?.sdp || null,
    estado: 'ringing',
    destinatarios,
    tomada_por: null,
    tomada_por_nombre: null,
    inicio_at: inicio_at.toISOString(),
    timer: null,
  };
  activas.set(call_id, registro);

  // Si nadie contesta, Meta la corta sola; el timer solo limpia la UI.
  registro.timer = setTimeout(() => {
    const c = activas.get(call_id);
    if (c && c.estado === 'ringing') {
      c.estado = 'missed';
      emitirA(c.destinatarios, 'LLAMADA_TERMINADA', payloadPublico(call_id, { motivo: 'sin_respuesta' }));
    }
  }, TIMBRE_MAX_MS);

  emitirA(destinatarios, 'LLAMADA_ENTRANTE', {
    ...payloadPublico(call_id),
    sdp_offer: registro.sdp_offer,
    encargado: cliente?.id_encargado ? Number(cliente.id_encargado) : null,
  });
  console.log(
    `[llamadas] entrante ${call_id} cfg ${configuracion.id} de ${telefono} → ${destinatarios.length} asesor(es)`,
  );
}

async function llamadaTerminada(configuracion, call) {
  const call_id = call.id;
  const c = activas.get(call_id);
  const estadoMeta = String(call.status || '');
  const duracion = Number(call.duration || 0);
  const contestada = /completed/i.test(estadoMeta) && (c?.tomada_por || duracion > 0);
  const estadoFinal = contestada
    ? 'completed'
    : c?.estado === 'rejected'
      ? 'rejected'
      : /not answered|missed|unavailable/i.test(estadoMeta) || !c?.tomada_por
        ? 'missed'
        : 'failed';

  const fila = await LlamadasWhatsapp.findOne({ where: { call_id } });
  if (fila) {
    await fila.update({
      estado: estadoFinal,
      fin_at: call.end_time ? new Date(Number(call.end_time) * 1000) : new Date(),
      duracion_seg: duracion,
      estado_meta: estadoMeta || null,
      id_sub_usuario: fila.id_sub_usuario || c?.tomada_por || null,
    });
  }

  const idCliente = fila?.id_cliente_chat_center || c?.id_cliente || null;
  const cliente = idCliente ? await ClientesChatCenter.findByPk(idCliente) : null;
  const quien = fila?.id_sub_usuario ? await nombreSubUsuario(fila.id_sub_usuario) : c?.tomada_por_nombre;
  const saliente = (fila?.direccion || c?.direccion) === 'BUSINESS_INITIATED';
  const rechazadaPorCliente = c?.estado === 'rejected_cliente';
  const texto = saliente
    ? estadoFinal === 'completed'
      ? `📞 ${quien || 'El equipo'} llamó por WhatsApp · ${fmtDuracion(duracion)}`
      : rechazadaPorCliente
        ? `📵 ${quien || 'El equipo'} llamó por WhatsApp y el cliente no aceptó`
        : `📵 ${quien || 'El equipo'} llamó por WhatsApp y no contestaron`
    : estadoFinal === 'completed'
      ? `📞 Llamada de WhatsApp atendida por ${quien || 'el equipo'} · ${fmtDuracion(duracion)}`
      : estadoFinal === 'rejected'
        ? `📵 Llamada de WhatsApp rechazada${quien ? ` por ${quien}` : ''}`
        : `📵 Llamada de WhatsApp perdida: nadie contestó`;
  await notificarEnChat(configuracion, cliente, texto);

  if (c) {
    clearTimeout(c.timer);
    c.estado = estadoFinal;
    emitirA(c.destinatarios, 'LLAMADA_TERMINADA', payloadPublico(call_id, { motivo: estadoFinal, duracion_seg: duracion }));
    activas.delete(call_id);
  }
}

/* ═══════════════════════════════════════════════════════════════════════
   ACCIONES DEL ASESOR (Graph: POST /{PHONE_NUMBER_ID}/calls)
   ═══════════════════════════════════════════════════════════════════════ */
async function accionGraph(configuracion, body) {
  const r = await ax(configuracion.token).post(
    `${GRAPH()}/${configuracion.id_telefono}/calls`,
    { messaging_product: 'whatsapp', ...body },
  );
  if (r.status >= 400) {
    const err = r.data?.error || {};
    const e = new Error(err.message || `Meta respondió ${r.status}`);
    e.meta = err;
    e.status = r.status;
    throw e;
  }
  return r.data;
}

function llamadaViva(call_id) {
  const c = activas.get(call_id);
  if (!c) {
    const e = new Error('La llamada ya no está activa');
    e.status = 410;
    throw e;
  }
  return c;
}

async function cargarConfig(id_configuracion) {
  const cfg = await Configuraciones.findByPk(id_configuracion);
  if (!cfg) throw new Error('Conexión no encontrada');
  return cfg;
}

/** Primer paso al contestar: reclama la llamada y manda pre_accept. */
async function aceptar({ call_id, sdp_answer, id_sub_usuario }) {
  const c = llamadaViva(call_id);
  if (c.tomada_por && Number(c.tomada_por) !== Number(id_sub_usuario)) {
    const e = new Error(`La tomó ${c.tomada_por_nombre || 'otro asesor'}`);
    e.status = 409;
    e.tomada_por = { id_sub_usuario: c.tomada_por, nombre: c.tomada_por_nombre };
    throw e;
  }
  if (!c.tomada_por) {
    c.tomada_por = Number(id_sub_usuario);
    c.tomada_por_nombre = await nombreSubUsuario(id_sub_usuario);
    c.estado = 'accepting';
    clearTimeout(c.timer);
    await LlamadasWhatsapp.update(
      { estado: 'accepted', id_sub_usuario, contestada_at: new Date() },
      { where: { call_id } },
    );
    // Al resto: ya la tomó alguien.
    emitirA(
      c.destinatarios.filter((id) => Number(id) !== Number(id_sub_usuario)),
      'LLAMADA_TOMADA',
      payloadPublico(call_id),
    );
  }
  const cfg = await cargarConfig(c.id_configuracion);
  c.sdp_answer = sdp_answer;
  await accionGraph(cfg, {
    call_id,
    action: 'pre_accept',
    session: { sdp_type: 'answer', sdp: sdp_answer },
  });
  return payloadPublico(call_id);
}

/** Segundo paso: el navegador ya tiene audio conectado → accept. */
async function confirmar({ call_id, id_sub_usuario }) {
  const c = llamadaViva(call_id);
  if (Number(c.tomada_por) !== Number(id_sub_usuario)) {
    const e = new Error('Esta llamada no es tuya');
    e.status = 409;
    throw e;
  }
  if (c.estado === 'accepted') return payloadPublico(call_id);
  const cfg = await cargarConfig(c.id_configuracion);
  await accionGraph(cfg, {
    call_id,
    action: 'accept',
    session: { sdp_type: 'answer', sdp: c.sdp_answer },
  });
  c.estado = 'accepted';
  return payloadPublico(call_id);
}

async function rechazar({ call_id, id_sub_usuario }) {
  const c = llamadaViva(call_id);
  if (c.tomada_por && Number(c.tomada_por) !== Number(id_sub_usuario)) {
    const e = new Error(`La tomó ${c.tomada_por_nombre || 'otro asesor'}`);
    e.status = 409;
    throw e;
  }
  const cfg = await cargarConfig(c.id_configuracion);
  c.estado = 'rejected';
  c.tomada_por = Number(id_sub_usuario);
  c.tomada_por_nombre = await nombreSubUsuario(id_sub_usuario);
  clearTimeout(c.timer);
  await LlamadasWhatsapp.update(
    { estado: 'rejected', id_sub_usuario },
    { where: { call_id } },
  );
  await accionGraph(cfg, { call_id, action: 'reject' });
  emitirA(c.destinatarios, 'LLAMADA_TERMINADA', payloadPublico(call_id, { motivo: 'rejected' }));
  return payloadPublico(call_id);
}

async function terminar({ call_id, id_sub_usuario }) {
  const c = llamadaViva(call_id);
  if (Number(c.tomada_por) !== Number(id_sub_usuario)) {
    const e = new Error('Esta llamada no es tuya');
    e.status = 409;
    throw e;
  }
  const cfg = await cargarConfig(c.id_configuracion);
  await accionGraph(cfg, { call_id, action: 'terminate' });
  // El cierre real (duración, notificación) llega por el webhook terminate.
  return payloadPublico(call_id);
}

/** Llamadas timbrando o en curso que le tocan a este asesor (al recargar),
 *  más un diagnóstico: si su sesión está en la sala de avisos de este proceso. */
async function activasPara(id_sub_usuario) {
  const out = [];
  for (const [call_id, c] of activas) {
    if (c.estado === 'missed') continue;
    if (!c.destinatarios.map(Number).includes(Number(id_sub_usuario))) continue;
    out.push({ ...payloadPublico(call_id), sdp_offer: c.tomada_por ? null : c.sdp_offer });
  }
  const conteo = await socketsEnSala([id_sub_usuario]);
  return {
    llamadas: out,
    diagnostico: {
      id_sub_usuario: Number(id_sub_usuario),
      sockets_en_sala: conteo[Number(id_sub_usuario)] ?? 0,
      pid: process.pid,
      llamadas_vivas: activas.size,
    },
  };
}

/* ═══════════════════════════════════════════════════════════════════════
   CONFIGURACIÓN DEL NÚMERO (Graph: /{PHONE_NUMBER_ID}/settings)
   ═══════════════════════════════════════════════════════════════════════ */
/* Meta no ofrece llamadas por API a los números que siguen en la app
   WhatsApp Business del celular (coexistencia): responde (#141000) "The
   phone number is not a valid Cloud API number". No hay forma fiable de
   saberlo antes (sincronizo_coexistencia no siempre está marcado), así que
   el switch se muestra siempre y el error se traduce a algo entendible. */
const CODIGO_NO_CLOUD_API = 141000;
function traducirErrorMeta(err, status) {
  if (Number(err?.code) === CODIGO_NO_CLOUD_API) {
    return (
      'Este número también está en la app de WhatsApp Business del celular. ' +
      'Para recibir llamadas en ChatCenter debe estar conectado solo por la API. ' +
      'Mientras tanto, las llamadas de tus clientes siguen sonando en el teléfono.'
    );
  }
  return err?.message || `WhatsApp respondió ${status}`;
}

async function leerConfiguracionLlamadas(id_configuracion) {
  const cfg = await cargarConfig(id_configuracion);
  const r = await ax(cfg.token).get(`${GRAPH()}/${cfg.id_telefono}/settings`);
  if (r.status >= 400) {
    const err = r.data?.error || {};
    return {
      activo: false,
      no_cloud_api: Number(err.code) === CODIGO_NO_CLOUD_API,
      error: traducirErrorMeta(err, r.status),
    };
  }
  const calling = r.data?.calling || {};
  return {
    activo: calling.status === 'ENABLED',
    no_cloud_api: false,
    icono: calling.call_icon_visibility || null,
    callback: calling.callback_permission_status || null,
    raw: calling,
  };
}

async function activarLlamadas(id_configuracion, activo) {
  const cfg = await cargarConfig(id_configuracion);
  const body = activo
    ? {
        calling: {
          status: 'ENABLED',
          call_icon_visibility: 'DEFAULT',
          callback_permission_status: 'ENABLED',
        },
      }
    : { calling: { status: 'DISABLED' } };
  const r = await ax(cfg.token).post(`${GRAPH()}/${cfg.id_telefono}/settings`, body);
  if (r.status >= 400) {
    const err = r.data?.error || {};
    const e = new Error(traducirErrorMeta(err, r.status));
    e.meta = err;
    e.status = 400;
    e.no_cloud_api = Number(err.code) === CODIGO_NO_CLOUD_API;
    throw e;
  }
  return leerConfiguracionLlamadas(id_configuracion);
}

/* ═══════════════════════════════════════════════════════════════════════
   FASE 2: PERMISO Y LLAMADA SALIENTE (el negocio llama al cliente)
   Reglas de Meta: hay que pedir permiso (1 solicitud por 24 h, 2 por
   semana); si el cliente acepta dura 7 días (o permanente si él lo marca).
   Estas llamadas SÍ se cobran por minuto según el país del cliente.
   ═══════════════════════════════════════════════════════════════════════ */
async function clienteDeConexion(id_configuracion, id_cliente) {
  const cliente = await ClientesChatCenter.findByPk(id_cliente);
  if (!cliente || Number(cliente.id_configuracion) !== Number(id_configuracion)) {
    const e = new Error('El chat no es de esta conexión');
    e.status = 404;
    throw e;
  }
  if (!cliente.celular_cliente) {
    const e = new Error('El contacto no tiene número de WhatsApp');
    e.status = 400;
    throw e;
  }
  return cliente;
}

/** Estado del permiso del cliente (GET /{PHONE_NUMBER_ID}/call_permissions). */
async function estadoPermiso(id_configuracion, id_cliente) {
  const cfg = await cargarConfig(id_configuracion);
  const cliente = await clienteDeConexion(id_configuracion, id_cliente);
  const r = await ax(cfg.token).get(
    `${GRAPH()}/${cfg.id_telefono}/call_permissions`,
    { params: { user_wa_id: cliente.celular_cliente } },
  );
  if (r.status >= 400) {
    const err = r.data?.error || {};
    return {
      status: 'desconocido',
      puede_pedir: false,
      puede_llamar: false,
      error: traducirErrorMeta(err, r.status),
    };
  }
  const permiso = r.data?.permission || {};
  const acciones = r.data?.actions || [];
  const accion = (n) => acciones.find((a) => a.action_name === n);
  return {
    status: permiso.status || 'no_permission',
    expira_at: permiso.expiration_time
      ? new Date(Number(permiso.expiration_time) * 1000).toISOString()
      : null,
    puede_pedir: accion('send_call_permission_request')?.can_perform_action === true,
    puede_llamar: accion('start_call')?.can_perform_action === true,
    limites: acciones,
  };
}

/** Manda al cliente el mensaje interactivo de "¿podemos llamarte?". */
async function solicitarPermiso({ id_configuracion, id_cliente, id_sub_usuario, texto }) {
  const cfg = await cargarConfig(id_configuracion);
  const cliente = await clienteDeConexion(id_configuracion, id_cliente);
  const cuerpo =
    String(texto || '').trim() ||
    `Hola, somos ${cfg.nombre_configuracion}. ¿Podemos llamarte por WhatsApp para atenderte mejor? Toca "Aceptar" y te llamamos.`;
  const r = await ax(cfg.token).post(`${GRAPH()}/${cfg.id_telefono}/messages`, {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: cliente.celular_cliente,
    type: 'interactive',
    interactive: {
      type: 'call_permission_request',
      action: { name: 'call_permission_request' },
      body: { text: cuerpo },
    },
  });
  if (r.status >= 400) {
    const err = r.data?.error || {};
    const e = new Error(traducirErrorMeta(err, r.status));
    e.meta = err;
    e.status = 400;
    throw e;
  }
  const wamid = r.data?.messages?.[0]?.id || null;
  const nombre = await nombreSubUsuario(id_sub_usuario);
  const propietario = await ClientesChatCenter.findOne({
    where: { id_configuracion, propietario: 1 },
    attributes: ['id'],
  });
  await MensajesClientes.create({
    id_configuracion,
    mid_mensaje: cfg.id_telefono,
    tipo_mensaje: 'text',
    rol_mensaje: 1,
    id_cliente: propietario?.id || null,
    uid_whatsapp: cliente.celular_cliente,
    id_wamid_mensaje: wamid,
    responsable: nombre,
    texto_mensaje: `📞 Solicitud de permiso para llamar: "${cuerpo}"`,
    celular_recibe: cliente.id,
    informacion_suficiente: 1,
    visto: 0,
    created_at: new Date(),
    updated_at: new Date(),
  });
  try {
    await enviarConsultaAPI(id_configuracion, cliente.id);
  } catch (e) {
    console.error('[llamadas] refresco del chat falló:', e.message);
  }
  return { wamid };
}

/** El cliente respondió a la solicitud (llega como mensaje interactivo). */
async function avisarRespuestaPermiso(id_configuracion, telefono, reply) {
  const cfg = await Configuraciones.findByPk(id_configuracion);
  if (!cfg) return;
  const { buscarContactoWa } = require('../utils/unified/dedupeContacto');
  const idCliente = await buscarContactoWa({ id_configuracion, telefono });
  const cliente = idCliente ? await ClientesChatCenter.findByPk(idCliente) : null;
  const destinatarios = cliente?.id_encargado
    ? [Number(cliente.id_encargado)]
    : await equipoDeConexion(id_configuracion, cfg.id_usuario);
  emitirA(destinatarios, 'LLAMADA_PERMISO', {
    id_configuracion,
    id_cliente_chat_center: cliente?.id || null,
    telefono,
    response: reply?.response || null,
    is_permanent: reply?.is_permanent === true,
    expiration_timestamp: reply?.expiration_timestamp || null,
  });
}

/** El asesor llama al cliente: POST /calls action connect con su oferta. */
async function llamar({ id_configuracion, id_cliente, id_sub_usuario, sdp_offer }) {
  const cfg = await cargarConfig(id_configuracion);
  const cliente = await clienteDeConexion(id_configuracion, id_cliente);
  const data = await accionGraph(cfg, {
    to: cliente.celular_cliente,
    action: 'connect',
    session: { sdp_type: 'offer', sdp: sdp_offer },
  });
  const call_id = data?.calls?.[0]?.id;
  if (!call_id) throw new Error('WhatsApp no devolvió el id de la llamada');
  const nombreAsesor = await nombreSubUsuario(id_sub_usuario);
  const inicio_at = new Date();
  await LlamadasWhatsapp.create({
    call_id,
    id_configuracion,
    id_cliente_chat_center: cliente.id,
    direccion: 'BUSINESS_INITIATED',
    telefono_cliente: cliente.celular_cliente,
    estado: 'ringing',
    id_sub_usuario,
    inicio_at,
  });
  activas.set(call_id, {
    id_configuracion,
    id_usuario: cfg.id_usuario,
    id_cliente: cliente.id,
    telefono: cliente.celular_cliente,
    nombre_cliente:
      `${cliente.nombre_cliente || ''} ${cliente.apellido_cliente || ''}`.trim() ||
      cliente.celular_cliente,
    direccion: 'BUSINESS_INITIATED',
    sdp_offer,
    sdp_answer: null,
    estado: 'llamando',
    destinatarios: [Number(id_sub_usuario)],
    tomada_por: Number(id_sub_usuario),
    tomada_por_nombre: nombreAsesor,
    inicio_at: inicio_at.toISOString(),
    timer: null,
  });
  return payloadPublico(call_id);
}

module.exports = {
  manejarWebhookLlamadas,
  aceptar,
  confirmar,
  rechazar,
  terminar,
  activasPara,
  leerConfiguracionLlamadas,
  activarLlamadas,
  estadoPermiso,
  solicitarPermiso,
  avisarRespuestaPermiso,
  llamar,
};
