const { db } = require('../database/config');
const catchAsync = require('../utils/catchAsync');
const zadarma = require('../services/zadarma.service');
const TelefoniaLlamadas = require('../models/telefonia_llamadas.model');
const TelefoniaMovimientos = require('../models/telefonia_movimientos.model');

/**
 * Telefonía por saldo (Zadarma). Ver services/zadarma.service.js.
 * Sesión como fuente de verdad: el asesor y la cuenta salen de req.sessionUser.
 */
const responderError = (res, e) =>
  res.status(e.status || 500).json({
    status: 'error',
    code: e.code || null,
    message: e.message,
    zadarma: e.zadarma || null,
  });

async function verificarConexion(req, res) {
  const id_configuracion = Number(req.body.id_configuracion || req.query.id_configuracion);
  if (!id_configuracion) {
    res.status(400).json({ status: 'error', message: 'Falta id_configuracion' });
    return null;
  }
  const [row] = await db.query(
    `SELECT id FROM configuraciones WHERE id = ? AND id_usuario = ? LIMIT 1`,
    { replacements: [id_configuracion, req.sessionUser.id_usuario], type: db.QueryTypes.SELECT },
  );
  if (!row) {
    res.status(403).json({ status: 'error', message: 'La conexión no es de esta cuenta' });
    return null;
  }
  return id_configuracion;
}

/** Llave + login SIP para que el navegador registre el widget de Zadarma. */
exports.widget = catchAsync(async (req, res) => {
  await zadarma.cargarCredenciales();
  if (!zadarma.configurado()) {
    return res.json({ status: 'success', data: { activo: false } });
  }
  // Solo para la conexión abierta si tiene telefonía activa (y de la cuenta
  // del asesor): así el teléfono no se carga en las demás conexiones ni se
  // gastan extensiones en asesores que no van a llamar.
  const id_configuracion = Number(req.query.id_configuracion);
  if (!id_configuracion) return res.json({ status: 'success', data: { activo: false } });
  const [propia] = await db.query(
    `SELECT id FROM configuraciones WHERE id = ? AND id_usuario = ? LIMIT 1`,
    { replacements: [id_configuracion, req.sessionUser.id_usuario], type: db.QueryTypes.SELECT },
  );
  if (!propia || !(await zadarma.conexionTieneTelefonia(id_configuracion))) {
    return res.json({ status: 'success', data: { activo: false } });
  }
  try {
    const data = await zadarma.llaveWidget(req.sessionUser.id_sub_usuario);
    return res.json({ status: 'success', data: { activo: true, ...data } });
  } catch (e) {
    return responderError(res, e);
  }
});

/** Saldo y tarifa de la conexión (para el botón y el aviso de sin saldo). */
exports.saldo = catchAsync(async (req, res) => {
  const id_configuracion = await verificarConexion(req, res);
  if (!id_configuracion) return undefined;
  await zadarma.cargarCredenciales();
  const cuenta = await zadarma.cuentaDe(id_configuracion);
  if (!cuenta) {
    // Sin cuenta asignada por el super admin: el chat no muestra el botón.
    return res.json({ status: 'success', data: { activo: false } });
  }
  return res.json({
    status: 'success',
    data: {
      activo: zadarma.configurado() && Number(cuenta.activo) === 1,
      saldo_centavos: cuenta.saldo_centavos,
      tarifa_centavos_min: cuenta.tarifa_centavos_min,
      caller_id: cuenta.caller_id,
      minutos_disponibles: Math.floor(cuenta.saldo_centavos / cuenta.tarifa_centavos_min),
    },
  });
});

exports.llamar = catchAsync(async (req, res) => {
  const id_configuracion = await verificarConexion(req, res);
  if (!id_configuracion) return undefined;
  const id_cliente = Number(req.body.id_cliente_chat_center);
  if (!id_cliente) {
    return res.status(400).json({ status: 'error', message: 'Falta id_cliente_chat_center' });
  }
  try {
    const data = await zadarma.llamar({
      id_configuracion,
      id_cliente,
      id_sub_usuario: req.sessionUser.id_sub_usuario,
      modo: req.body.modo === 'callback' ? 'callback' : 'directo',
    });
    return res.json({ status: 'success', data });
  } catch (e) {
    return responderError(res, e);
  }
});

exports.historial = catchAsync(async (req, res) => {
  const id_configuracion = await verificarConexion(req, res);
  if (!id_configuracion) return undefined;
  const id_cliente = Number(req.query.id_cliente_chat_center) || null;
  const where = { id_configuracion };
  if (id_cliente) where.id_cliente_chat_center = id_cliente;
  const rows = await TelefoniaLlamadas.findAll({ where, order: [['id', 'DESC']], limit: 100 });
  return res.json({ status: 'success', data: rows });
});

exports.movimientos = catchAsync(async (req, res) => {
  const id_configuracion = await verificarConexion(req, res);
  if (!id_configuracion) return undefined;
  const rows = await TelefoniaMovimientos.findAll({
    where: { id_configuracion },
    order: [['id', 'DESC']],
    limit: 200,
  });
  return res.json({ status: 'success', data: rows });
});

/** Recarga manual (super administrador). centavos > 0. */
exports.recargar = catchAsync(async (req, res) => {
  const id_configuracion = Number(req.body.id_configuracion);
  const centavos = Math.round(Number(req.body.centavos));
  if (!id_configuracion || !Number.isFinite(centavos) || centavos <= 0) {
    return res.status(400).json({ status: 'error', message: 'id_configuracion y centavos (> 0) son requeridos' });
  }
  const saldo = await zadarma.recargar(
    id_configuracion,
    centavos,
    req.sessionUser.id_sub_usuario,
    req.body.detalle || 'Recarga manual',
  );
  return res.json({ status: 'success', data: { saldo_centavos: saldo } });
});

/** Caller ID y tarifa de una conexión (super administrador). */
exports.configurarCuenta = catchAsync(async (req, res) => {
  const id_configuracion = Number(req.body.id_configuracion);
  if (!id_configuracion) {
    return res.status(400).json({ status: 'error', message: 'Falta id_configuracion' });
  }
  const cuenta = await zadarma.cuentaDe(id_configuracion, { crear: true });
  const cambios = { updated_at: new Date() };
  if (req.body.caller_id !== undefined) cambios.caller_id = String(req.body.caller_id || '').replace(/\D/g, '') || null;
  if (req.body.tarifa_centavos_min !== undefined) cambios.tarifa_centavos_min = Math.max(1, Math.round(Number(req.body.tarifa_centavos_min)));
  if (req.body.activo !== undefined) cambios.activo = req.body.activo ? 1 : 0;
  await cuenta.update(cambios);
  // Al guardar un número se comprueba de una vez si Zadarma lo acepta.
  let numero = null;
  if (cambios.caller_id) {
    try {
      numero = await zadarma.comprobarNumero(id_configuracion, cambios.caller_id);
    } catch (e) {
      numero = { numero: cambios.caller_id, verificado: false, detalle: e.message };
    }
  }
  return res.json({ status: 'success', data: { cuenta, numero } });
});

/** Vuelve a comprobar en Zadarma el número de salida de una conexión. */
exports.comprobarNumero = catchAsync(async (req, res) => {
  const id_configuracion = Number(req.body.id_configuracion);
  if (!id_configuracion) {
    return res.status(400).json({ status: 'error', message: 'Falta id_configuracion' });
  }
  const cuenta = await zadarma.cuentaDe(id_configuracion);
  const numero = req.body.numero || cuenta?.caller_id;
  if (!numero) {
    return res.status(400).json({ status: 'error', message: 'La conexión no tiene número de salida' });
  }
  try {
    return res.json({ status: 'success', data: await zadarma.comprobarNumero(id_configuracion, numero) });
  } catch (e) {
    return responderError(res, e);
  }
});

/** Estado de la cuenta maestra y de la central (super administrador). */
exports.diagnostico = catchAsync(async (req, res) => {
  return res.json({ status: 'success', data: await zadarma.diagnostico() });
});

/** Registra nuestro webhook en Zadarma y enciende la grabación (super admin). */
exports.instalar = catchAsync(async (req, res) => {
  const url =
    req.body.url ||
    `${process.env.API_PUBLIC_URL || 'https://chat.imporfactory.app'}/api/v1/telefonia/webhook`;
  try {
    const data = await zadarma.configurarCuenta(url, req.body.email || req.sessionUser.email || null);
    return res.json({ status: 'success', data: { url, ...data } });
  } catch (e) {
    return responderError(res, e);
  }
});

/** Webhook de Zadarma: GET con zd_echo para validar la URL, POST con eventos. */
exports.webhook = catchAsync(async (req, res) => {
  if (req.method === 'GET') {
    if (req.query.zd_echo !== undefined) return res.status(200).send(String(req.query.zd_echo));
    return res.status(200).send('ok');
  }
  const body = req.body || {};
  await zadarma.cargarCredenciales();
  const firma = req.get('Signature') || req.get('signature');
  if (!zadarma.firmaValida(body, firma)) {
    console.warn('[telefonia] webhook con firma inválida', body.event, body.pbx_call_id || '');
    return res.status(403).send('bad signature');
  }
  res.status(200).send('ok');
  setImmediate(() => {
    zadarma.manejarWebhook(body).catch((e) =>
      console.error('[telefonia] webhook falló:', body.event, e.message),
    );
  });
  return undefined;
});

/* ── Cuenta maestra y administración (super administrador) ── */
exports.maestraEstado = catchAsync(async (req, res) => {
  const data = await zadarma.estadoCredenciales();
  if (data.configurada) {
    try {
      data.balance = await zadarma.balance();
    } catch (e) {
      data.balance_error = e.message;
    }
  }
  return res.json({ status: 'success', data });
});

exports.maestraGuardar = catchAsync(async (req, res) => {
  const { user_key, secret, sip_principal } = req.body || {};
  if (!user_key || !secret) {
    return res.status(400).json({ status: 'error', message: 'user_key y secret son requeridos' });
  }
  try {
    const saldo = await zadarma.guardarCredenciales({
      user_key,
      secret,
      sip_principal: sip_principal || null,
      id_sub_usuario: req.sessionUser.id_sub_usuario,
    });
    return res.json({ status: 'success', data: { balance: saldo } });
  } catch (e) {
    return responderError(res, e);
  }
});

/** Conexiones con saldo telefónico configurado. */
exports.cuentas = catchAsync(async (req, res) => {
  const rows = await db.query(
    `SELECT tc.id_configuracion, c.nombre_configuracion, c.telefono, tc.saldo_centavos,
            tc.tarifa_centavos_min, tc.caller_id, tc.activo, tc.updated_at,
            tn.verificado AS numero_verificado, tn.comprobado_at AS numero_comprobado_at,
            (SELECT COUNT(*) FROM telefonia_llamadas l WHERE l.id_configuracion = tc.id_configuracion) AS llamadas
     FROM telefonia_cuentas tc
     LEFT JOIN configuraciones c ON c.id = tc.id_configuracion
     LEFT JOIN telefonia_numeros tn ON tn.id_configuracion = tc.id_configuracion AND tn.numero = tc.caller_id
     ORDER BY tc.updated_at DESC, tc.id_configuracion DESC`,
    { type: db.QueryTypes.SELECT },
  );
  return res.json({ status: 'success', data: rows });
});

/** Buscar conexiones por id o nombre para darles saldo. */
exports.conexiones = catchAsync(async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (!q) return res.json({ status: 'success', data: [] });
  const rows = await db.query(
    `SELECT id, nombre_configuracion, telefono, id_usuario
     FROM configuraciones
     WHERE suspendido = 0 AND pending_suspension = 0 AND wa_status = 'CONNECTED'
       AND (id = ? OR nombre_configuracion LIKE ? OR telefono LIKE ?)
     ORDER BY id DESC LIMIT 20`,
    { replacements: [Number(q) || 0, `%${q}%`, `%${q}%`], type: db.QueryTypes.SELECT },
  );
  return res.json({ status: 'success', data: rows });
});
