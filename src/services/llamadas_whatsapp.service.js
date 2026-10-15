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
  // Llamada por número puente: el webhook llega al puente, el chat es de otra
  const idCfgChat = Number(fila?.id_configuracion || c?.id_configuracion) || configuracion.id;
  const cfgChat =
    idCfgChat !== Number(configuracion.id)
      ? (await Configuraciones.findByPk(idCfgChat)) || configuracion
      : configuracion;
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
  await notificarEnChat(cfgChat, cliente, texto);

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
    const e = new Error(traducirErrorMeta(err, r.status));
    e.meta = err;
    e.status = r.status;
    // Para depurar una SDP rechazada: la causa de Meta y la SDP enviada.
    console.error(
      `[llamadas] Meta rechazó ${body.action} (${r.status}): ${e.message}`,
      body.session?.sdp ? `
--- SDP enviada ---
${body.session.sdp}
-------------------` : '',
    );
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
  // Meta manda la causa exacta (por ejemplo, de una SDP inválida) en
  // error_data.details; sin eso el mensaje es solo "SDP Validation error".
  const detalle = err?.error_data?.details || err?.details || '';
  const base = err?.message || `WhatsApp respondió ${status}`;
  return detalle ? `${base} — ${detalle}` : base;
}

/** Estado de llamadas del número + la conexión puente, si tiene una. */
async function leerConfiguracionLlamadas(id_configuracion) {
  const propio = await leerCallingNumero(id_configuracion);
  const { id_configuracion_llamadas } = await ajustesLlamadas(id_configuracion);
  let puente = null;
  if (id_configuracion_llamadas && id_configuracion_llamadas !== Number(id_configuracion)) {
    const cfgP = await Configuraciones.findByPk(id_configuracion_llamadas);
    if (cfgP) {
      const est = await leerCallingNumero(cfgP.id).catch(() => ({ activo: false }));
      puente = {
        id_configuracion: cfgP.id,
        nombre: cfgP.nombre_configuracion,
        telefono: cfgP.telefono,
        activo: est.activo === true && Number(cfgP.suspendido) !== 1,
      };
    }
  }
  return { ...propio, puente };
}

async function leerCallingNumero(id_configuracion) {
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
   CONEXIÓN PUENTE Y NOMBRE
   Un número en coexistencia (app + API) no puede llamar: Meta exige solo
   Cloud API. Esa conexión puede llamar DESDE otra de la misma cuenta
   (configuraciones.id_configuracion_llamadas). El chat, el historial y las
   notas siguen en la conexión del chat; el permiso y la llamada salen por
   el número puente, así que el cliente ve ese número.
   ═══════════════════════════════════════════════════════════════════════ */
const esColumnaFaltante = (e) =>
  /ER_BAD_FIELD_ERROR|Unknown column/i.test(`${e?.original?.code || ''} ${e?.message || ''}`);

/** Ajustes de llamadas de la conexión. Tolera la migración sin aplicar. */
async function ajustesLlamadas(id_configuracion) {
  try {
    const [row] = await db.query(
      `SELECT id_configuracion_llamadas, nombre_llamadas
         FROM configuraciones WHERE id = ? LIMIT 1`,
      { replacements: [id_configuracion], type: db.QueryTypes.SELECT },
    );
    return {
      id_configuracion_llamadas: Number(row?.id_configuracion_llamadas) || null,
      nombre_llamadas: String(row?.nombre_llamadas || '').trim() || null,
    };
  } catch (e) {
    if (esColumnaFaltante(e)) return { id_configuracion_llamadas: null, nombre_llamadas: null };
    throw e;
  }
}

/** { cfgChat, cfgLlama }: la conexión del chat y la que hace la llamada. */
async function conexionQueLlama(id_configuracion) {
  const cfgChat = await cargarConfig(id_configuracion);
  const { id_configuracion_llamadas: idPuente } = await ajustesLlamadas(id_configuracion);
  if (!idPuente || idPuente === Number(cfgChat.id)) return { cfgChat, cfgLlama: cfgChat };
  const cfgLlama = await Configuraciones.findOne({
    where: { id: idPuente, id_usuario: cfgChat.id_usuario, suspendido: 0 },
  });
  if (!cfgLlama) {
    const e = new Error('La conexión desde la que se llama ya no está disponible. Revísala en la configuración de llamadas.');
    e.status = 400;
    throw e;
  }
  return { cfgChat, cfgLlama };
}

/* Nombre verificado del número en WhatsApp (cache 1 h). */
const cacheNombreWa = new Map();
async function nombreWhatsapp(cfg) {
  const c = cacheNombreWa.get(cfg.id_telefono);
  if (c && Date.now() - c.at < 3600_000) return c.nombre;
  const r = await ax(cfg.token).get(`${GRAPH()}/${cfg.id_telefono}`, {
    params: { fields: 'verified_name' },
  });
  const nombre = r.status < 400 ? String(r.data?.verified_name || '').trim() || null : null;
  cacheNombreWa.set(cfg.id_telefono, { nombre, at: Date.now() });
  return nombre;
}

/** Con qué nombre se presenta el negocio: personalizado > WhatsApp > conexión. */
async function nombrePresentacion(cfgChat) {
  const { nombre_llamadas } = await ajustesLlamadas(cfgChat.id);
  if (nombre_llamadas) return nombre_llamadas;
  const wa = await nombreWhatsapp(cfgChat).catch(() => null);
  return wa || cfgChat.nombre_configuracion;
}

async function leerAjustes(id_configuracion) {
  const cfg = await cargarConfig(id_configuracion);
  const ajustes = await ajustesLlamadas(id_configuracion);
  const opciones = await db.query(
    `SELECT id, nombre_configuracion, telefono
       FROM configuraciones
      WHERE id_usuario = ? AND id <> ? AND suspendido = 0
        AND id_telefono IS NOT NULL AND id_telefono <> ''
      ORDER BY nombre_configuracion`,
    { replacements: [cfg.id_usuario, cfg.id], type: db.QueryTypes.SELECT },
  );
  return {
    ...ajustes,
    nombre_whatsapp: await nombreWhatsapp(cfg).catch(() => null),
    nombre_configuracion: cfg.nombre_configuracion,
    opciones,
  };
}

async function guardarAjustes({ id_configuracion, id_configuracion_llamadas, nombre_llamadas }) {
  const cfg = await cargarConfig(id_configuracion);
  const idPuente = Number(id_configuracion_llamadas) || null;
  if (idPuente) {
    const p = await Configuraciones.findOne({
      where: { id: idPuente, id_usuario: cfg.id_usuario, suspendido: 0 },
    });
    if (!p || p.id === cfg.id) {
      const e = new Error('Elige otra conexión activa de esta misma cuenta');
      e.status = 400;
      throw e;
    }
    const est = await leerCallingNumero(p.id);
    if (!est.activo) {
      const e = new Error(`«${p.nombre_configuracion}» no tiene las llamadas de WhatsApp encendidas. Enciéndelas primero en esa conexión.`);
      e.status = 400;
      throw e;
    }
  }
  const nombre = String(nombre_llamadas || '').trim().slice(0, 100) || null;
  try {
    await db.query(
      `UPDATE configuraciones SET id_configuracion_llamadas = ?, nombre_llamadas = ? WHERE id = ?`,
      { replacements: [idPuente, nombre, cfg.id] },
    );
  } catch (e) {
    if (esColumnaFaltante(e)) {
      const err = new Error('Falta aplicar la migración llamadas_puente_migration.sql');
      err.status = 500;
      throw err;
    }
    throw e;
  }
  return leerAjustes(id_configuracion);
}

/* ── Ventana de 24 h y plantilla de permiso ──
   Fuera de la ventana, Meta acepta el mensaje libre "¿podemos llamarte?"
   pero nunca llega. Ahí va la plantilla con el componente
   call_permission_request: abre la conversación y pide el permiso. */
const PLANTILLA_PERMISO = 'permiso_llamada_whatsapp';
const TEXTO_PLANTILLA =
  'Hola, te escribimos de {{1}}. Queremos llamarte por WhatsApp para atenderte mejor. ¿Nos das permiso? Toca el botón de abajo.';

/** ¿El cliente le escribió a este número en las últimas 24 h? (23 h de margen) */
async function ventanaAbierta(cfgLlama, telefono) {
  const { buscarContactoWa } = require('../utils/unified/dedupeContacto');
  const idCli = await buscarContactoWa({ id_configuracion: cfgLlama.id, telefono });
  if (!idCli) return false;
  const [row] = await db.query(
    `SELECT 1 AS ok FROM mensajes_clientes
      WHERE id_configuracion = ? AND celular_recibe = ? AND rol_mensaje = 0
        AND deleted_at IS NULL AND created_at >= NOW() - INTERVAL 23 HOUR
      LIMIT 1`,
    { replacements: [cfgLlama.id, idCli], type: db.QueryTypes.SELECT },
  );
  return !!row;
}

/** Busca la plantilla en la WABA; si no existe, la crea. Devuelve su estado. */
const cachePlantilla = new Map(); // waba → { status, language, at }
async function asegurarPlantillaPermiso(cfg) {
  const waba = cfg.id_whatsapp;
  if (!waba) return { status: 'SIN_WABA' };
  const c = cachePlantilla.get(waba);
  if (c && c.status === 'APPROVED' && Date.now() - c.at < 3600_000) return c;
  const base = `${GRAPH()}/${waba}/message_templates`;
  const r = await ax(cfg.token).get(base, {
    params: { name: PLANTILLA_PERMISO, fields: 'name,status,language,rejected_reason' },
  });
  if (r.status >= 400) {
    return { status: 'ERROR', error: traducirErrorMeta(r.data?.error || {}, r.status) };
  }
  const t = (r.data?.data || []).find((x) => x.name === PLANTILLA_PERMISO);
  if (t) {
    const out = { status: t.status, language: t.language, rejected_reason: t.rejected_reason, at: Date.now() };
    cachePlantilla.set(waba, out);
    return out;
  }
  const cr = await ax(cfg.token).post(base, {
    name: PLANTILLA_PERMISO,
    language: 'es',
    category: 'UTILITY',
    components: [
      { type: 'BODY', text: TEXTO_PLANTILLA, example: { body_text: [['Imporfactory']] } },
      { type: 'call_permission_request' },
    ],
  });
  if (cr.status >= 400) {
    return { status: 'ERROR', error: traducirErrorMeta(cr.data?.error || {}, cr.status) };
  }
  const out = { status: cr.data?.status || 'PENDING', language: 'es', at: Date.now() };
  cachePlantilla.set(waba, out);
  return out;
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
  const { cfgLlama: cfg } = await conexionQueLlama(id_configuracion);
  const cliente = await clienteDeConexion(id_configuracion, id_cliente);
  const desde =
    Number(cfg.id) !== Number(id_configuracion)
      ? { id_configuracion: cfg.id, nombre: cfg.nombre_configuracion, telefono: cfg.telefono }
      : null;
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
      desde,
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
    desde,
    // Sin conversación en 24 h el permiso sale como plantilla
    ventana_abierta: await ventanaAbierta(cfg, cliente.celular_cliente).catch(() => false),
  };
}

/** Manda al cliente el mensaje interactivo de "¿podemos llamarte?". */
async function solicitarPermiso({ id_configuracion, id_cliente, id_sub_usuario, texto }) {
  const { cfgChat, cfgLlama: cfg } = await conexionQueLlama(id_configuracion);
  const cliente = await clienteDeConexion(id_configuracion, id_cliente);
  const nombreNegocio = await nombrePresentacion(cfgChat);
  const abierta = await ventanaAbierta(cfg, cliente.celular_cliente);

  let cuerpo;
  let mensaje;
  if (abierta) {
    cuerpo =
      String(texto || '').trim() ||
      `Hola, somos ${nombreNegocio}. ¿Podemos llamarte por WhatsApp para atenderte mejor? Toca "Aceptar" y te llamamos.`;
    mensaje = {
      type: 'interactive',
      interactive: {
        type: 'call_permission_request',
        action: { name: 'call_permission_request' },
        body: { text: cuerpo },
      },
    };
  } else {
    const plantilla = await asegurarPlantillaPermiso(cfg);
    if (plantilla.status !== 'APPROVED') {
      const e = new Error(
        plantilla.status === 'PENDING'
          ? 'El cliente no escribe hace más de 24 h: el permiso va por plantilla y WhatsApp aún la está revisando (suele tardar minutos). Intenta de nuevo en un rato.'
          : plantilla.status === 'REJECTED'
            ? `WhatsApp rechazó la plantilla de permiso de llamada${plantilla.rejected_reason ? ` (${plantilla.rejected_reason})` : ''}.`
            : `No se pudo preparar la plantilla de permiso de llamada: ${plantilla.error || plantilla.status}`,
      );
      e.status = 409;
      throw e;
    }
    cuerpo = TEXTO_PLANTILLA.replace('{{1}}', nombreNegocio);
    mensaje = {
      type: 'template',
      template: {
        name: PLANTILLA_PERMISO,
        language: { code: plantilla.language || 'es' },
        components: [
          { type: 'body', parameters: [{ type: 'text', text: nombreNegocio }] },
        ],
      },
    };
  }

  const r = await ax(cfg.token).post(`${GRAPH()}/${cfg.id_telefono}/messages`, {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: cliente.celular_cliente,
    ...mensaje,
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
    texto_mensaje: `📞 Solicitud de permiso para llamar${abierta ? '' : ' (plantilla)'}${
      cfg.id !== cfgChat.id ? ` desde ${cfg.nombre_configuracion}` : ''
    }: "${cuerpo}"`,
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
  return { wamid, via: abierta ? 'mensaje' : 'plantilla' };
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

  // Conexiones que llaman por este número: el chat del cliente vive allá
  let vinculadas = [];
  try {
    vinculadas = await db.query(
      `SELECT id FROM configuraciones
        WHERE id_configuracion_llamadas = ? AND suspendido = 0`,
      { replacements: [id_configuracion], type: db.QueryTypes.SELECT },
    );
  } catch (e) {
    if (!esColumnaFaltante(e)) throw e;
  }
  for (const { id } of vinculadas) {
    const cfgChat = await Configuraciones.findByPk(id);
    const idCli = cfgChat ? await buscarContactoWa({ id_configuracion: id, telefono }) : null;
    if (!idCli) continue;
    const cli = await ClientesChatCenter.findByPk(idCli);
    const dest = cli?.id_encargado
      ? [Number(cli.id_encargado)]
      : await equipoDeConexion(id, cfgChat.id_usuario);
    // La respuesta en sí llega al chat como espejo (reflejarEnConexionesQueLlaman)
    emitirA(dest, 'LLAMADA_PERMISO', {
      id_configuracion: id,
      id_cliente_chat_center: idCli,
      telefono,
      response: reply?.response || null,
      is_permanent: reply?.is_permanent === true,
      expiration_timestamp: reply?.expiration_timestamp || null,
    });
  }
}

/* ── Espejo ──
   Lo que el cliente le escribe al número puente se copia (solo lectura) al
   chat de la conexión que lo llama: rol 3 + tipo 'espejo', así no cuenta en
   métricas ni dispara bots. Solo hasta 72 h y 10 mensajes desde la última
   llamada o pedido de permiso por el puente; al pasar el tope, un aviso. */
const ESPEJO_HORAS = 72;
const ESPEJO_MAX = 10;
const ETIQUETA_ESPEJO = {
  image: '[Imagen]',
  video: '[Video]',
  audio: '[Audio]',
  document: '[Documento]',
  sticker: '[Sticker]',
  location: '[Ubicación]',
};

async function reflejarEnConexionesQueLlaman({ id_configuracion, telefono, tipo_mensaje, texto_mensaje }) {
  let vinculadas = [];
  try {
    vinculadas = await db.query(
      `SELECT id FROM configuraciones
        WHERE id_configuracion_llamadas = ? AND suspendido = 0`,
      { replacements: [id_configuracion], type: db.QueryTypes.SELECT },
    );
  } catch (e) {
    if (esColumnaFaltante(e)) return;
    throw e;
  }
  if (!vinculadas.length) return;

  const puente = await Configuraciones.findByPk(id_configuracion);
  if (!puente) return;
  const { buscarContactoWa } = require('../utils/unified/dedupeContacto');
  const texto =
    String(texto_mensaje || '').trim() || ETIQUETA_ESPEJO[tipo_mensaje] || `[${tipo_mensaje || 'Mensaje'}]`;

  for (const { id } of vinculadas) {
    const idCli = await buscarContactoWa({ id_configuracion: id, telefono });
    if (!idCli) continue;
    // Última llamada o pedido de permiso por el puente (dentro de 72 h)
    const [ultimo] = await db.query(
      `SELECT MAX(t) AS desde FROM (
         SELECT MAX(created_at) AS t FROM mensajes_clientes
          WHERE id_configuracion = ? AND celular_recibe = ? AND rol_mensaje = 1
            AND mid_mensaje = ? AND created_at >= NOW() - INTERVAL ${ESPEJO_HORAS} HOUR
         UNION ALL
         SELECT MAX(inicio_at) FROM llamadas_whatsapp
          WHERE id_configuracion = ? AND id_cliente_chat_center = ?
            AND direccion = 'BUSINESS_INITIATED' AND inicio_at >= NOW() - INTERVAL ${ESPEJO_HORAS} HOUR
       ) x`,
      {
        replacements: [id, idCli, puente.id_telefono, id, idCli],
        type: db.QueryTypes.SELECT,
      },
    );
    if (!ultimo?.desde) continue;

    // Tope de mensajes por llamada; al pasarlo, un solo aviso y se corta
    const [{ n, avisado }] = await db.query(
      `SELECT SUM(tipo_mensaje = 'espejo') AS n,
              SUM(tipo_mensaje = 'notificacion' AND texto_mensaje LIKE 'El cliente siguió escribiendo en %') AS avisado
         FROM mensajes_clientes
        WHERE id_configuracion = ? AND celular_recibe = ? AND rol_mensaje = 3
          AND created_at >= ?`,
      { replacements: [id, idCli, ultimo.desde], type: db.QueryTypes.SELECT },
    );
    if (Number(avisado) > 0) continue;
    const cfgChat = await Configuraciones.findByPk(id);
    const cli = await ClientesChatCenter.findByPk(idCli);
    if (Number(n) >= ESPEJO_MAX) {
      await notificarEnChat(
        cfgChat,
        cli,
        `El cliente siguió escribiendo en ${puente.nombre_configuracion}. Míralo en esa conexión.`,
      );
      continue;
    }

    const propietario = await ClientesChatCenter.findOne({
      where: { id_configuracion: id, propietario: 1 },
      attributes: ['id'],
    });
    await MensajesClientes.create({
      id_configuracion: id,
      id_cliente: propietario?.id || null,
      mid_mensaje: puente.id_telefono,
      tipo_mensaje: 'espejo',
      rol_mensaje: 3,
      texto_mensaje: texto,
      responsable: puente.nombre_configuracion,
      celular_recibe: idCli,
      uid_whatsapp: telefono,
      visto: 0,
    });
    try {
      await enviarConsultaAPI(id, idCli);
    } catch (e) {
      console.error('[llamadas] refresco del chat (espejo) falló:', e.message);
    }
  }
}

/** El asesor llama al cliente: POST /calls action connect con su oferta. */
async function llamar({ id_configuracion, id_cliente, id_sub_usuario, sdp_offer }) {
  const { cfgChat: cfg, cfgLlama } = await conexionQueLlama(id_configuracion);
  const cliente = await clienteDeConexion(id_configuracion, id_cliente);
  const data = await accionGraph(cfgLlama, {
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
  emitirA,
  notificarEnChat,
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
  leerAjustes,
  guardarAjustes,
  reflejarEnConexionesQueLlaman,
  asegurarPlantillaPermiso,
};
