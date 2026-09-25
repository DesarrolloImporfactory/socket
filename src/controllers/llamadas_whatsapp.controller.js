const { db } = require('../database/config');
const catchAsync = require('../utils/catchAsync');
const llamadas = require('../services/llamadas_whatsapp.service');

/**
 * Llamadas de voz por WhatsApp (ver services/llamadas_whatsapp.service.js).
 * Todas las rutas van con `protect`: el asesor sale de la sesión, nunca del
 * body. Los errores del servicio traen `status` (409 = la tomó otro,
 * 410 = ya no está activa) y se devuelven tal cual para que el front
 * reaccione.
 */
const responderError = (res, e) =>
  res.status(e.status || 500).json({
    status: 'error',
    message: e.message,
    tomada_por: e.tomada_por || null,
    meta: e.meta || null,
    no_cloud_api: e.no_cloud_api === true,
  });

/** La conexión debe ser de la cuenta del asesor. */
async function verificarConexion(req, res) {
  const id_configuracion = Number(
    req.body.id_configuracion || req.query.id_configuracion,
  );
  if (!id_configuracion) {
    res.status(400).json({ status: 'error', message: 'Falta id_configuracion' });
    return null;
  }
  const [row] = await db.query(
    `SELECT id FROM configuraciones WHERE id = ? AND id_usuario = ? LIMIT 1`,
    {
      replacements: [id_configuracion, req.sessionUser.id_usuario],
      type: db.QueryTypes.SELECT,
    },
  );
  if (!row) {
    res.status(403).json({ status: 'error', message: 'La conexión no es de esta cuenta' });
    return null;
  }
  return id_configuracion;
}

exports.aceptar = catchAsync(async (req, res) => {
  const { call_id, sdp_answer } = req.body;
  if (!call_id || !sdp_answer) {
    return res.status(400).json({ status: 'error', message: 'Faltan call_id o sdp_answer' });
  }
  try {
    const data = await llamadas.aceptar({
      call_id,
      sdp_answer,
      id_sub_usuario: req.sessionUser.id_sub_usuario,
    });
    return res.json({ status: 'success', data });
  } catch (e) {
    return responderError(res, e);
  }
});

exports.confirmar = catchAsync(async (req, res) => {
  try {
    const data = await llamadas.confirmar({
      call_id: req.body.call_id,
      id_sub_usuario: req.sessionUser.id_sub_usuario,
    });
    return res.json({ status: 'success', data });
  } catch (e) {
    return responderError(res, e);
  }
});

exports.rechazar = catchAsync(async (req, res) => {
  try {
    const data = await llamadas.rechazar({
      call_id: req.body.call_id,
      id_sub_usuario: req.sessionUser.id_sub_usuario,
    });
    return res.json({ status: 'success', data });
  } catch (e) {
    return responderError(res, e);
  }
});

exports.terminar = catchAsync(async (req, res) => {
  try {
    const data = await llamadas.terminar({
      call_id: req.body.call_id,
      id_sub_usuario: req.sessionUser.id_sub_usuario,
    });
    return res.json({ status: 'success', data });
  } catch (e) {
    return responderError(res, e);
  }
});

/** Llamadas timbrando/en curso para este asesor (al abrir o recargar la app). */
exports.activas = catchAsync(async (req, res) => {
  return res.json({
    status: 'success',
    data: llamadas.activasPara(req.sessionUser.id_sub_usuario),
  });
});

exports.obtenerConfiguracion = catchAsync(async (req, res) => {
  const id_configuracion = await verificarConexion(req, res);
  if (!id_configuracion) return undefined;
  const data = await llamadas.leerConfiguracionLlamadas(id_configuracion);
  return res.json({ status: 'success', data });
});

exports.guardarConfiguracion = catchAsync(async (req, res) => {
  const id_configuracion = await verificarConexion(req, res);
  if (!id_configuracion) return undefined;
  try {
    const data = await llamadas.activarLlamadas(
      id_configuracion,
      req.body.activo === true || req.body.activo === 1 || req.body.activo === '1',
    );
    return res.json({ status: 'success', data });
  } catch (e) {
    return responderError(res, e);
  }
});

/** Historial reciente de la conexión (para el chat y el dashboard). */
exports.historial = catchAsync(async (req, res) => {
  const id_configuracion = await verificarConexion(req, res);
  if (!id_configuracion) return undefined;
  const id_cliente = Number(req.query.id_cliente_chat_center) || null;
  const rows = await db.query(
    `SELECT l.call_id, l.direccion, l.estado, l.telefono_cliente, l.inicio_at,
            l.contestada_at, l.fin_at, l.duracion_seg, l.id_sub_usuario,
            su.nombre_encargado, l.id_cliente_chat_center
     FROM llamadas_whatsapp l
     LEFT JOIN sub_usuarios_chat_center su ON su.id_sub_usuario = l.id_sub_usuario
     WHERE l.id_configuracion = ? ${id_cliente ? 'AND l.id_cliente_chat_center = ?' : ''}
     ORDER BY l.inicio_at DESC LIMIT 100`,
    {
      replacements: id_cliente ? [id_configuracion, id_cliente] : [id_configuracion],
      type: db.QueryTypes.SELECT,
    },
  );
  return res.json({ status: 'success', data: rows });
});

/* ── Fase 2: permiso y llamada saliente ── */
exports.estadoPermiso = catchAsync(async (req, res) => {
  const id_configuracion = await verificarConexion(req, res);
  if (!id_configuracion) return undefined;
  const id_cliente = Number(req.query.id_cliente_chat_center);
  if (!id_cliente) {
    return res.status(400).json({ status: 'error', message: 'Falta id_cliente_chat_center' });
  }
  try {
    const data = await llamadas.estadoPermiso(id_configuracion, id_cliente);
    return res.json({ status: 'success', data });
  } catch (e) {
    return responderError(res, e);
  }
});

exports.solicitarPermiso = catchAsync(async (req, res) => {
  const id_configuracion = await verificarConexion(req, res);
  if (!id_configuracion) return undefined;
  const id_cliente = Number(req.body.id_cliente_chat_center);
  if (!id_cliente) {
    return res.status(400).json({ status: 'error', message: 'Falta id_cliente_chat_center' });
  }
  try {
    const data = await llamadas.solicitarPermiso({
      id_configuracion,
      id_cliente,
      id_sub_usuario: req.sessionUser.id_sub_usuario,
      texto: req.body.texto,
    });
    return res.json({ status: 'success', data });
  } catch (e) {
    return responderError(res, e);
  }
});

exports.llamar = catchAsync(async (req, res) => {
  const id_configuracion = await verificarConexion(req, res);
  if (!id_configuracion) return undefined;
  const id_cliente = Number(req.body.id_cliente_chat_center);
  const { sdp_offer } = req.body;
  if (!id_cliente || !sdp_offer) {
    return res.status(400).json({ status: 'error', message: 'Faltan id_cliente_chat_center o sdp_offer' });
  }
  try {
    const data = await llamadas.llamar({
      id_configuracion,
      id_cliente,
      id_sub_usuario: req.sessionUser.id_sub_usuario,
      sdp_offer,
    });
    return res.json({ status: 'success', data });
  } catch (e) {
    return responderError(res, e);
  }
});
