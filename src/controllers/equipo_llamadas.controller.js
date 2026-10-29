const catchAsync = require('../utils/catchAsync');
const AppError = require('../utils/appError');
const { db } = require('../database/config');
const LlamadasWhatsapp = require('../models/llamadas_whatsapp.model');
const TelefoniaLlamadas = require('../models/telefonia_llamadas.model');
const llamadasWa = require('../services/llamadas_whatsapp.service');
const zadarma = require('../services/zadarma.service');

/*  LLAMAR AL CLIENTE DESDE TEAM (27-oct-2026, pedido de gerencia: «botón
 *  Llamar en Team con el número tapado, la 265 llamando por WhatsApp desde el
 *  número puente y Zadarma de respaldo»).
 *
 *  Team manda solo el chat. El número lo pone el servidor y no vuelve nunca:
 *  ni en el cuerpo de las respuestas ni en el id de la llamada. El call_id de
 *  Meta («wacid.…») lleva el número en base64, igual que el wamid; por eso Team
 *  sigue la llamada con el id de la fila (llamadas_whatsapp.id /
 *  telefonia_llamadas.id) y el call_id se queda acá.
 *
 *  1. WhatsApp (la vía de siempre): el navegador de la silla arma la oferta de
 *     audio, el servidor la manda a Meta desde el número puente y Team
 *     pregunta cada segundo por la respuesta (el socket está cerrado al rol
 *     «equipo»). Pide permiso del cliente: si no lo dio, «Pedir permiso» le
 *     manda el mensaje de WhatsApp de «¿podemos llamarte?».
 *  2. Teléfono con saldo (Zadarma, respaldo): SOLO callback. Zadarma timbra la
 *     extensión del asesor y después marca al cliente. El modo directo (el
 *     navegador marca el número) no existe para Team.
 *
 *  La señal de audio (SDP) trae tiras largas de cifras que el tapado de
 *  teléfonos confundiría con celulares; viaja escrita solo con letras
 *  (`aLetras`) y Team la vuelve a armar en el navegador.
 *
 *  Prendido por partes, sin tocar la configuración de las conexiones:
 *    EQUIPO_LLAMADAS=1                 prende las rutas (si no, «no disponible»)
 *    EQUIPO_LLAMADAS_SUBS=378,377      solo esos asesores (vacío = todos)
 *    EQUIPO_LLAMADAS_PUENTE=265:818    línea del chat → número desde el que se
 *                                      llama por WhatsApp (si una línea no está,
 *                                      usa el puente de su configuración)
 *    EQUIPO_LLAMADAS_CHATS=239984      en prueba: solo esos chats (vacío = todos)
 *    EQUIPO_LLAMADAS_ZADARMA=1         prende el respaldo con saldo
 */

const { aLetras, puentes, habilitado, chatEnPrueba, zadarmaPrendido, faseWa } = require('../utils/equipoLlamadas');

// Tope por asesor: llamar y pedir permiso cuestan (Meta cobra el minuto y
// limita las solicitudes de permiso por cliente).
const TOPE_POR_MINUTO = 4;
const recientes = new Map();
function pasaElTope(id_sub_usuario, ahora = Date.now()) {
  const r = (recientes.get(id_sub_usuario) || []).filter((t) => ahora - t < 60_000);
  if (r.length >= TOPE_POR_MINUTO) {
    recientes.set(id_sub_usuario, r);
    return false;
  }
  r.push(ahora);
  recientes.set(id_sub_usuario, r);
  return true;
}

function log(datos) {
  console.log('[EQUIPO_LLAMADA]', JSON.stringify(datos));
}

/* ───────── comprobaciones comunes ───────── */

function exigirHabilitado(req) {
  if (!habilitado(req.sessionUser.id_sub_usuario)) {
    throw new AppError('Las llamadas desde Team todavía no están prendidas para tu usuario.', 403);
  }
}

function exigirEscritura(req) {
  if (req.sesionTeamSoloLectura) {
    throw new AppError('Estás en «Ver como»: desde aquí no se llama.', 403);
  }
}

const EN_PRUEBA = 'Las llamadas desde Team están en prueba: este chat todavía no se puede llamar.';

/** El chat tiene que ser del asesor (asignado a él) y de una línea de su
 *  cuenta. Devuelve { id_configuracion, id_cliente } o lanza 404. */
async function chatPropio(req, idConfig) {
  const id_cliente = Number(req.params.id_cliente);
  const id_configuracion = Number(idConfig);
  if (!Number.isInteger(id_cliente) || id_cliente <= 0 || !Number.isInteger(id_configuracion) || id_configuracion <= 0) {
    throw new AppError('Chat no válido', 400);
  }
  const u = req.sessionUser;
  const [fila] = await db.query(
    `SELECT c.id, c.source, (c.celular_cliente IS NOT NULL AND c.celular_cliente <> '') AS tiene_numero
       FROM clientes_chat_center c
       INNER JOIN configuraciones cfg ON cfg.id = c.id_configuracion
      WHERE c.id = ? AND c.id_configuracion = ? AND c.propietario != 1
        AND c.id_encargado = ? AND cfg.id_usuario = ? AND cfg.suspendido = 0
      LIMIT 1`,
    { replacements: [id_cliente, id_configuracion, Number(u.id_sub_usuario), Number(u.id_usuario)], type: db.QueryTypes.SELECT },
  );
  if (!fila) throw new AppError('Ese chat no está asignado a ti.', 404);
  if (!chatEnPrueba(id_cliente)) throw new AppError(EN_PRUEBA, 403);
  if (!Number(fila.tiene_numero)) throw new AppError('Este contacto no tiene número para llamar.', 422);
  return { id_configuracion, id_cliente, source: String(fila.source || 'wa').toLowerCase() };
}

/** Error de un servicio → AppError con un mensaje para la silla, sin datos de adentro. */
function traducir(e, porDefecto) {
  if (e instanceof AppError) return e;
  const status = Number(e?.status) || 0;
  const conocido = status >= 400 && status < 500 && typeof e?.message === 'string' && !/\d{7}/.test(e.message);
  return new AppError(conocido ? e.message : porDefecto, status >= 400 && status < 600 ? status : 502);
}

/* ═══════════════════════════════════════════════════════════════════════
   ¿POR DÓNDE SE PUEDE LLAMAR?
   ═══════════════════════════════════════════════════════════════════════ */

/*  GET /api/v1/equipo/llamadas/yo — ¿se le muestra el botón a esta silla?
 *  Una vez por página, sin preguntar a Meta. */
exports.yo = catchAsync(async (req, res) => {
  const activo = habilitado(req.sessionUser.id_sub_usuario) && !req.sesionTeamSoloLectura;
  res.json({ status: 'success', data: { activo } });
});

/*  GET /api/v1/equipo/llamadas/chats/:id_cliente/disponible?id_configuracion= */
exports.disponible = catchAsync(async (req, res, next) => {
  const u = req.sessionUser;
  if (!habilitado(u.id_sub_usuario)) {
    return res.json({ status: 'success', data: { activo: false } });
  }
  if (!chatEnPrueba(req.params.id_cliente)) {
    return res.json({ status: 'success', data: { activo: false, motivo: EN_PRUEBA } });
  }
  const chat = await chatPropio(req, req.query.id_configuracion);
  const puente = puentes()[chat.id_configuracion] || null;

  // «wa» y «saldo», no «whatsapp»/«telefono»: claves así se tapan como número.
  const wa = { activo: false };
  if (chat.source === 'wa') {
    try {
      const p = await llamadasWa.estadoPermiso(chat.id_configuracion, chat.id_cliente, puente);
      const conPuente = !!p.desde;
      wa.activo = p.status !== 'desconocido';
      wa.permiso = p.status;
      wa.expira_at = p.expira_at || null;
      wa.puede_llamar = !!p.puede_llamar;
      wa.puede_pedir = !!p.puede_pedir;
      wa.ventana_abierta = !!p.ventana_abierta;
      wa.desde = conPuente ? p.desde.nombre : null;
      if (p.error) wa.motivo = 'Esta línea no puede llamar por WhatsApp ahora.';
    } catch (e) {
      wa.motivo = 'Esta línea no puede llamar por WhatsApp ahora.';
      console.error('[EQUIPO_LLAMADA] permiso', chat.id_configuracion, e.message);
    }
  } else {
    wa.motivo = 'Este chat no es de WhatsApp.';
  }

  const saldo = { activo: false };
  if (zadarmaPrendido()) {
    try {
      const bolsa = await zadarma.cuentaSaldoDe(chat.id_configuracion);
      saldo.activo = !!bolsa && Number(bolsa.activo) === 1 && Number(bolsa.saldo_centavos) > 0
        && (await zadarma.conexionTieneTelefonia(chat.id_configuracion));
      if (!saldo.activo) saldo.motivo = 'La línea no tiene saldo de llamadas.';
    } catch (e) {
      saldo.motivo = 'El teléfono con saldo no está disponible ahora.';
      console.error('[EQUIPO_LLAMADA] saldo', chat.id_configuracion, e.message);
    }
  }

  res.json({ status: 'success', data: { activo: true, wa, saldo } });
});

/* ═══════════════════════════════════════════════════════════════════════
   WHATSAPP
   ═══════════════════════════════════════════════════════════════════════ */

/*  POST /api/v1/equipo/llamadas/chats/:id_cliente/permiso { id_configuracion } */
exports.pedirPermiso = catchAsync(async (req, res, next) => {
  exigirEscritura(req);
  exigirHabilitado(req);
  const u = req.sessionUser;
  const chat = await chatPropio(req, req.body?.id_configuracion);
  if (chat.source !== 'wa') return next(new AppError('Este chat no es de WhatsApp.', 422));
  if (!pasaElTope(Number(u.id_sub_usuario))) {
    return next(new AppError('Vas muy rápido: espera un minuto.', 429));
  }
  try {
    const r = await llamadasWa.solicitarPermiso({
      id_configuracion: chat.id_configuracion,
      id_cliente: chat.id_cliente,
      id_sub_usuario: u.id_sub_usuario,
      puente: puentes()[chat.id_configuracion] || null,
    });
    log({ accion: 'permiso', sub: u.id_sub_usuario, chat: chat.id_cliente, linea: chat.id_configuracion, via: r.via, ok: true });
    res.json({ status: 'success', data: { via: r.via } });
  } catch (e) {
    log({ accion: 'permiso', sub: u.id_sub_usuario, chat: chat.id_cliente, linea: chat.id_configuracion, ok: false, error: e.message });
    throw traducir(e, 'WhatsApp no aceptó la solicitud de permiso. Vuelve a intentar en un rato.');
  }
});

/*  POST /api/v1/equipo/llamadas/chats/:id_cliente/whatsapp { id_configuracion, sdp_offer }
 *  La oferta llega tal cual (el tapado solo toca lo que sale). */
exports.llamarWhatsapp = catchAsync(async (req, res, next) => {
  exigirEscritura(req);
  exigirHabilitado(req);
  const u = req.sessionUser;
  const sdp = typeof req.body?.sdp_offer === 'string' ? req.body.sdp_offer : '';
  if (!/^v=0\r?\n/.test(sdp) || sdp.length > 20000) return next(new AppError('No se pudo preparar el audio. Vuelve a intentar.', 400));
  const chat = await chatPropio(req, req.body?.id_configuracion);
  if (chat.source !== 'wa') return next(new AppError('Este chat no es de WhatsApp.', 422));
  if (!pasaElTope(Number(u.id_sub_usuario))) {
    return next(new AppError('Vas muy rápido: espera un minuto.', 429));
  }
  let r;
  try {
    r = await llamadasWa.llamar({
      id_configuracion: chat.id_configuracion,
      id_cliente: chat.id_cliente,
      id_sub_usuario: u.id_sub_usuario,
      sdp_offer: sdp,
      puente: puentes()[chat.id_configuracion] || null,
    });
  } catch (e) {
    log({ accion: 'whatsapp', sub: u.id_sub_usuario, chat: chat.id_cliente, linea: chat.id_configuracion, ok: false, error: e.message });
    throw traducir(e, 'WhatsApp no aceptó la llamada. Vuelve a intentar en un momento.');
  }
  const fila = await LlamadasWhatsapp.findOne({ where: { call_id: r.call_id }, attributes: ['id'] });
  log({ accion: 'whatsapp', sub: u.id_sub_usuario, chat: chat.id_cliente, linea: chat.id_configuracion, llamada: fila?.id, ok: true });
  res.json({ status: 'success', data: { llamada: fila ? Number(fila.id) : null, fase: 'llamando' } });
});

async function filaWaPropia(req) {
  const id = Number(req.params.id_llamada);
  if (!Number.isInteger(id) || id <= 0) throw new AppError('Llamada no válida', 400);
  const fila = await LlamadasWhatsapp.findOne({
    where: { id, id_sub_usuario: Number(req.sessionUser.id_sub_usuario), direccion: 'BUSINESS_INITIATED' },
  });
  if (!fila) throw new AppError('Esa llamada no es tuya.', 404);
  return fila;
}

/*  GET /api/v1/equipo/llamadas/whatsapp/:id_llamada */
exports.estadoWhatsapp = catchAsync(async (req, res) => {
  const fila = await filaWaPropia(req);
  const vivo = llamadasWa.estadoSaliente(fila.call_id, req.sessionUser.id_sub_usuario);
  const data = { llamada: Number(fila.id), ...faseWa(vivo, fila) };
  if (vivo?.sdp_answer) data.audio = aLetras(vivo.sdp_answer);
  res.json({ status: 'success', data });
});

/*  POST /api/v1/equipo/llamadas/whatsapp/:id_llamada/colgar */
exports.colgarWhatsapp = catchAsync(async (req, res) => {
  const fila = await filaWaPropia(req);
  try {
    await llamadasWa.terminar({ call_id: fila.call_id, id_sub_usuario: req.sessionUser.id_sub_usuario });
  } catch (e) {
    // 410: ya había terminado (el cliente colgó primero). Lo demás se reporta.
    if (Number(e?.status) !== 410) throw traducir(e, 'No se pudo colgar. Vuelve a intentar.');
  }
  log({ accion: 'colgar', sub: req.sessionUser.id_sub_usuario, llamada: fila.id });
  res.json({ status: 'success', data: { llamada: Number(fila.id) } });
});

/* ═══════════════════════════════════════════════════════════════════════
   TELÉFONO CON SALDO (Zadarma, respaldo) — solo callback
   ═══════════════════════════════════════════════════════════════════════ */

function exigirZadarma() {
  if (!zadarmaPrendido()) throw new AppError('El teléfono con saldo no está prendido para Team.', 403);
}

/*  GET /api/v1/equipo/llamadas/telefono/widget — la extensión del asesor
 *  para el teléfono del navegador (la misma llave que usa ImporChat). */
exports.widgetTelefono = catchAsync(async (req, res) => {
  exigirEscritura(req);
  exigirHabilitado(req);
  exigirZadarma();
  let d;
  try {
    d = await zadarma.llaveWidget(Number(req.sessionUser.id_sub_usuario));
  } catch (e) {
    throw traducir(e, 'No se pudo preparar el teléfono. Vuelve a intentar en un momento.');
  }
  // Escrita con letras, como el audio: una llave con 9 cifras seguidas se taparía.
  res.json({ status: 'success', data: { llave: aLetras(JSON.stringify({ key: d.key, sip: d.sip })), extension: d.extension } });
});

/*  POST /api/v1/equipo/llamadas/chats/:id_cliente/telefono { id_configuracion }
 *  Zadarma timbra primero el teléfono del navegador del asesor y, cuando
 *  contesta, marca al cliente. */
exports.llamarTelefono = catchAsync(async (req, res, next) => {
  exigirEscritura(req);
  exigirHabilitado(req);
  exigirZadarma();
  const u = req.sessionUser;
  const chat = await chatPropio(req, req.body?.id_configuracion);
  if (!pasaElTope(Number(u.id_sub_usuario))) {
    return next(new AppError('Vas muy rápido: espera un minuto.', 429));
  }
  let r;
  try {
    r = await zadarma.llamar({
      id_configuracion: chat.id_configuracion,
      id_cliente: chat.id_cliente,
      id_sub_usuario: u.id_sub_usuario,
      modo: 'callback',
    });
  } catch (e) {
    log({ accion: 'telefono', sub: u.id_sub_usuario, chat: chat.id_cliente, linea: chat.id_configuracion, ok: false, error: e.message });
    throw traducir(e, 'No se pudo llamar por teléfono. Vuelve a intentar en un momento.');
  }
  log({ accion: 'telefono', sub: u.id_sub_usuario, chat: chat.id_cliente, linea: chat.id_configuracion, llamada: r.id, ok: true });
  res.json({
    status: 'success',
    data: { llamada: Number(r.id), fase: 'llamando', tarifa_centavos_min: r.tarifa_destino_centavos_min, saldo_centavos: r.saldo_centavos },
  });
});

/*  GET /api/v1/equipo/llamadas/telefono/:id_llamada */
exports.estadoTelefono = catchAsync(async (req, res, next) => {
  const id = Number(req.params.id_llamada);
  if (!Number.isInteger(id) || id <= 0) return next(new AppError('Llamada no válida', 400));
  const fila = await TelefoniaLlamadas.findOne({ where: { id, id_sub_usuario: Number(req.sessionUser.id_sub_usuario) } });
  if (!fila) return next(new AppError('Esa llamada no es tuya.', 404));
  let data;
  if (fila.fin_at) {
    data = { fase: 'terminada', motivo: fila.estado === 'answered' ? 'completada' : 'no_contesto', duracion_seg: Number(fila.duracion_seg) || 0 };
  } else {
    data = { fase: fila.estado === 'ringing' ? 'timbrando' : 'llamando' };
  }
  res.json({ status: 'success', data: { llamada: id, ...data } });
});
