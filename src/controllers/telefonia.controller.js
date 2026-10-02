const { db } = require('../database/config');
const catchAsync = require('../utils/catchAsync');
const zadarma = require('../services/zadarma.service');
const telefoniaIA = require('../services/telefonia_ia.service');
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

/** Columnas del historial con asesor, cliente y análisis IA (misma lista
 *  para el administrador de la conexión y para el super admin). */
const SQL_HISTORIAL_SELECT = `
  SELECT l.id, l.id_sub_usuario, l.id_cliente_chat_center, l.extension, l.telefono_cliente,
         l.caller_id, l.estado, l.disposition, l.inicio_at, l.fin_at, l.duracion_seg,
         l.costo_centavos, l.grabada, l.grabacion_url,
         su.nombre_encargado AS asesor, cc.nombre_cliente AS cliente,
         a.estado AS ia_estado, a.resumen AS ia_resumen, a.analisis AS ia_analisis,
         a.transcripcion AS ia_transcripcion, a.error AS ia_error
  FROM telefonia_llamadas l
  LEFT JOIN sub_usuarios_chat_center su ON su.id_sub_usuario = l.id_sub_usuario
  LEFT JOIN clientes_chat_center cc ON cc.id = l.id_cliente_chat_center
  LEFT JOIN telefonia_analisis a ON a.id_llamada = l.id`;

const parsearAnalisis = (r) => {
  let analisis = null;
  if (r.ia_analisis) {
    try {
      analisis = JSON.parse(r.ia_analisis);
    } catch {
      analisis = null;
    }
  }
  const { ia_analisis, ...resto } = r;
  return { ...resto, ia_analisis: analisis };
};

/**
 * Historial de llamadas de una conexión para su administrador (dashboard de
 * atención) y para el chat: rango de fechas opcional, filtro por cliente, y
 * un resumen (totales y por asesor) para las tarjetas.
 */
exports.historial = catchAsync(async (req, res) => {
  const id_configuracion = await verificarConexion(req, res);
  if (!id_configuracion) return undefined;
  const id_cliente = Number(req.query.id_cliente_chat_center) || null;
  const desde = /^\d{4}-\d{2}-\d{2}$/.test(req.query.desde || '') ? `${req.query.desde} 00:00:00` : null;
  const hasta = /^\d{4}-\d{2}-\d{2}$/.test(req.query.hasta || '') ? `${req.query.hasta} 23:59:59` : null;
  const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 200));
  const cond = ['l.id_configuracion = ?'];
  const repl = [id_configuracion];
  if (id_cliente) {
    cond.push('l.id_cliente_chat_center = ?');
    repl.push(id_cliente);
  }
  if (desde) {
    cond.push('l.inicio_at >= ?');
    repl.push(desde);
  }
  if (hasta) {
    cond.push('l.inicio_at <= ?');
    repl.push(hasta);
  }
  const rows = await db.query(`${SQL_HISTORIAL_SELECT} WHERE ${cond.join(' AND ')} ORDER BY l.id DESC LIMIT ?`, {
    replacements: [...repl, limit],
    type: db.QueryTypes.SELECT,
  });
  const data = rows.map(parsearAnalisis);
  const porAsesor = {};
  const tot = { llamadas: 0, contestadas: 0, segundos: 0, costo_centavos: 0, resultados: {} };
  for (const r of data) {
    const k = r.id_sub_usuario;
    porAsesor[k] = porAsesor[k] || { id_sub_usuario: k, asesor: r.asesor || `Asesor ${k}`, llamadas: 0, contestadas: 0, segundos: 0, costo_centavos: 0 };
    porAsesor[k].llamadas += 1;
    tot.llamadas += 1;
    if (r.estado === 'answered') {
      porAsesor[k].contestadas += 1;
      porAsesor[k].segundos += Number(r.duracion_seg) || 0;
      porAsesor[k].costo_centavos += Number(r.costo_centavos) || 0;
      tot.contestadas += 1;
      tot.segundos += Number(r.duracion_seg) || 0;
      tot.costo_centavos += Number(r.costo_centavos) || 0;
    }
    const res_ = r.ia_analisis?.resultado;
    if (res_) tot.resultados[res_] = (tot.resultados[res_] || 0) + 1;
  }
  const cuenta = await zadarma.cuentaDe(id_configuracion);
  return res.json({
    status: 'success',
    data,
    resumen: {
      ...tot,
      por_asesor: Object.values(porAsesor).sort((a, b) => b.llamadas - a.llamadas),
      saldo_centavos: cuenta?.saldo_centavos ?? null,
      tarifa_centavos_min: cuenta?.tarifa_centavos_min ?? null,
      activo: cuenta ? Number(cuenta.activo) === 1 : false,
    },
  });
});

/* ── Análisis con IA (super administrador): conteo y reintento. La llave es
      la de cada conexión (/asistentes); aquí no se guarda ninguna. ── */
exports.iaEstado = catchAsync(async (req, res) => {
  return res.json({ status: 'success', data: await telefoniaIA.estadoAnalisis() });
});

exports.iaReanalizar = catchAsync(async (req, res) => {
  const r = await telefoniaIA.reanalizarPendientes(Number(req.body.limite) || 50);
  return res.json({ status: 'success', data: r });
});

/**
 * Historial paginado de una conexión (super administrador), con el asesor,
 * el cliente y el número con el que salió cada llamada. Sirve para responder
 * "¿desde qué número salió?" ante una queja: `caller_id` es lo que Zadarma
 * reporta haber enviado; si la operadora lo reemplazó, eso ya no se ve.
 */
exports.historialAdmin = catchAsync(async (req, res) => {
  const id_configuracion = Number(req.query.id_configuracion);
  if (!id_configuracion) {
    return res.status(400).json({ status: 'error', message: 'Falta id_configuracion' });
  }
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));
  const page = Math.max(1, Number(req.query.page) || 1);
  const offset = (page - 1) * limit;
  const [{ total }] = await db.query(
    `SELECT COUNT(*) AS total FROM telefonia_llamadas WHERE id_configuracion = ?`,
    { replacements: [id_configuracion], type: db.QueryTypes.SELECT },
  );
  const rows = await db.query(`${SQL_HISTORIAL_SELECT} WHERE l.id_configuracion = ? ORDER BY l.id DESC LIMIT ? OFFSET ?`, {
    replacements: [id_configuracion, limit, offset],
    type: db.QueryTypes.SELECT,
  });
  return res.json({ status: 'success', data: rows.map(parsearAnalisis), total: Number(total), page, limit });
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
/**
 * Cobertura: cuánto costarían en Zadarma todos los minutos vendidos que aún
 * no se usaron, contra el saldo real de la cuenta maestra. Lo usa la tabla
 * de /telefonia y el candado de las recargas.
 */
async function coberturaZadarma() {
  const rows = await db.query(
    `SELECT tc.id_configuracion, tc.saldo_centavos, tc.tarifa_centavos_min, c.pais
     FROM telefonia_cuentas tc LEFT JOIN configuraciones c ON c.id = tc.id_configuracion
     WHERE tc.saldo_centavos > 0 AND tc.activo = 1`,
    { type: db.QueryTypes.SELECT },
  );
  await zadarma.cargarCredenciales();
  const costoPorPais = {};
  let balance = null;
  if (zadarma.configurado()) {
    balance = await zadarma.balance().catch(() => null);
    for (const pais of new Set(rows.map((r) => String(r.pais || 'ec').toLowerCase()))) {
      costoPorPais[pais] = await zadarma.costoReferencia(pais).catch(() => null);
    }
  }
  let costoPendiente = 0;
  for (const r of rows) {
    const costoMin = costoPorPais[String(r.pais || 'ec').toLowerCase()]?.centavos_min || 0;
    if (r.tarifa_centavos_min > 0 && costoMin) costoPendiente += (r.saldo_centavos / r.tarifa_centavos_min) * costoMin;
  }
  return {
    saldo_zadarma_centavos: balance ? Math.round(balance.balance * 100) : null,
    costo_pendiente_centavos: Math.round(costoPendiente),
    costoPorPais,
  };
}

exports.recargar = catchAsync(async (req, res) => {
  const id_configuracion = Number(req.body.id_configuracion);
  const centavos = Math.round(Number(req.body.centavos));
  if (!id_configuracion || !Number.isFinite(centavos) || centavos <= 0) {
    return res.status(400).json({ status: 'error', message: 'id_configuracion y centavos (> 0) son requeridos' });
  }
  /* Candado (2026-10-02): no se puede vender saldo que Zadarma no pueda
     pagar. Si todos los clientes usaran sus minutos, el costo total en
     Zadarma tiene que caber en el saldo de la cuenta maestra; si no, un
     cliente con saldo en ChatCenter vería "puedes llamar" y la llamada se
     cortaría. Antes era solo un aviso. */
  const cuenta = await zadarma.cuentaDe(id_configuracion, { crear: true });
  const [cfg] = await db.query(`SELECT pais FROM configuraciones WHERE id = ? LIMIT 1`, {
    replacements: [id_configuracion],
    type: db.QueryTypes.SELECT,
  });
  const cob = await coberturaZadarma();
  const costoMin = cob.costoPorPais[String(cfg?.pais || 'ec').toLowerCase()]?.centavos_min || 0;
  if (cob.saldo_zadarma_centavos != null && costoMin && cuenta.tarifa_centavos_min > 0) {
    const costoNuevo = (centavos / cuenta.tarifa_centavos_min) * costoMin;
    const disponible = cob.saldo_zadarma_centavos - cob.costo_pendiente_centavos;
    if (costoNuevo > disponible) {
      const maxRecarga = Math.max(0, Math.floor((disponible / costoMin) * cuenta.tarifa_centavos_min));
      return res.status(400).json({
        status: 'error',
        code: 'SALDO_ZADARMA_INSUFICIENTE',
        message:
          `Esta recarga vendería minutos que Zadarma no puede pagar: costarían $${(costoNuevo / 100).toFixed(2)} ` +
          `y en Zadarma quedan $${(Math.max(0, disponible) / 100).toFixed(2)} sin comprometer ` +
          `(saldo $${(cob.saldo_zadarma_centavos / 100).toFixed(2)}, ya vendido $${(cob.costo_pendiente_centavos / 100).toFixed(2)}). ` +
          (maxRecarga > 0
            ? `Máximo que puedes cargar ahora a esta conexión: $${(maxRecarga / 100).toFixed(2)}. `
            : '') +
          'Recarga primero la cuenta de Zadarma.',
        data: {
          saldo_zadarma_centavos: cob.saldo_zadarma_centavos,
          costo_pendiente_centavos: cob.costo_pendiente_centavos,
          costo_nuevo_centavos: Math.round(costoNuevo),
          max_recarga_centavos: maxRecarga,
        },
      });
    }
  }
  const saldo = await zadarma.recargar(
    id_configuracion,
    centavos,
    req.sessionUser.id_sub_usuario,
    req.body.detalle || 'Recarga manual',
  );
  return res.json({ status: 'success', data: { saldo_centavos: saldo } });
});

/** Apaga la telefonía de una conexión y le devuelve el saldo (super admin).
 *  Así lo apagado deja de comprometer saldo de Zadarma y queda libre para
 *  otras conexiones. Encender es /cuenta con activo=true (arranca en cero). */
exports.apagar = catchAsync(async (req, res) => {
  const id_configuracion = Number(req.body.id_configuracion);
  if (!id_configuracion) {
    return res.status(400).json({ status: 'error', message: 'Falta id_configuracion' });
  }
  const cuenta = await zadarma.cuentaDe(id_configuracion, { crear: true });
  const saldo = await zadarma.retirar(
    id_configuracion,
    Number.MAX_SAFE_INTEGER,
    req.sessionUser.id_sub_usuario,
    'Apagado desde /telefonia',
  );
  await cuenta.update({ activo: 0, updated_at: new Date() });
  return res.json({ status: 'success', data: { saldo_centavos: saldo, activo: 0 } });
});

/** Borra la fila de saldo de una conexión apagada y en cero (super admin).
 *  El historial de llamadas y los movimientos se conservan. */
exports.quitarCuenta = catchAsync(async (req, res) => {
  const id_configuracion = Number(req.body.id_configuracion);
  if (!id_configuracion) {
    return res.status(400).json({ status: 'error', message: 'Falta id_configuracion' });
  }
  const cuenta = await zadarma.cuentaDe(id_configuracion);
  if (!cuenta) return res.json({ status: 'success' });
  if (Number(cuenta.saldo_centavos) > 0) {
    return res.status(400).json({ status: 'error', message: 'La conexión todavía tiene saldo. Apágala primero (eso lo devuelve).' });
  }
  await cuenta.destroy();
  return res.json({ status: 'success' });
});

/** Quita saldo a una conexión (super administrador). Sin centavos = todo. */
exports.retirar = catchAsync(async (req, res) => {
  const id_configuracion = Number(req.body.id_configuracion);
  if (!id_configuracion) {
    return res.status(400).json({ status: 'error', message: 'Falta id_configuracion' });
  }
  const centavos = req.body.centavos != null ? Math.round(Number(req.body.centavos)) : Number.MAX_SAFE_INTEGER;
  const saldo = await zadarma.retirar(
    id_configuracion,
    centavos,
    req.sessionUser.id_sub_usuario,
    req.body.detalle || 'Retiro desde /telefonia',
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

/** Conexiones con saldo telefónico configurado, con costo real por minuto,
 *  margen y un resumen: cuánto saldo vendido hay pendiente frente a lo que
 *  la cuenta de Zadarma puede pagar. */
exports.cuentas = catchAsync(async (req, res) => {
  const rows = await db.query(
    `SELECT tc.id_configuracion, c.nombre_configuracion, c.telefono, c.pais, tc.saldo_centavos,
            tc.tarifa_centavos_min, tc.caller_id, tc.activo, tc.updated_at,
            tn.verificado AS numero_verificado, tn.comprobado_at AS numero_comprobado_at,
            (SELECT COUNT(*) FROM telefonia_llamadas l WHERE l.id_configuracion = tc.id_configuracion) AS llamadas
     FROM telefonia_cuentas tc
     LEFT JOIN configuraciones c ON c.id = tc.id_configuracion
     LEFT JOIN telefonia_numeros tn ON tn.id_configuracion = tc.id_configuracion AND tn.numero = tc.caller_id
     ORDER BY tc.updated_at DESC, tc.id_configuracion DESC`,
    { type: db.QueryTypes.SELECT },
  );
  await zadarma.cargarCredenciales();
  let costoPorPais = {};
  let balance = null;
  if (zadarma.configurado()) {
    balance = await zadarma.balance().catch(() => null);
    for (const pais of new Set(rows.map((r) => String(r.pais || 'ec').toLowerCase()))) {
      costoPorPais[pais] = await zadarma.costoReferencia(pais).catch(() => null);
    }
  }
  let minutosVendidos = 0;
  let costoPendiente = 0;
  const data = rows.map((r) => {
    const costo = costoPorPais[String(r.pais || 'ec').toLowerCase()];
    const costoMin = costo?.centavos_min || null;
    // Una conexión apagada no puede llamar: su saldo no compromete a Zadarma.
    const minutos = Number(r.activo) === 1 && r.tarifa_centavos_min > 0 ? r.saldo_centavos / r.tarifa_centavos_min : 0;
    minutosVendidos += minutos;
    if (costoMin) costoPendiente += minutos * costoMin;
    return {
      ...r,
      costo_centavos_min: costoMin,
      costo_descripcion: costo?.descripcion || null,
      margen_pct: costoMin && r.tarifa_centavos_min > 0 ? Math.round(((r.tarifa_centavos_min - costoMin) / r.tarifa_centavos_min) * 100) : null,
    };
  });
  const saldoZadarmaCentavos = balance ? Math.round(balance.balance * 100) : null;
  return res.json({
    status: 'success',
    data,
    resumen: {
      asignado_centavos: rows.reduce((a, r) => a + Number(r.saldo_centavos || 0), 0),
      minutos_vendidos: Math.round(minutosVendidos),
      costo_pendiente_centavos: Math.round(costoPendiente),
      saldo_zadarma_centavos: saldoZadarmaCentavos,
      cubierto: saldoZadarmaCentavos == null ? null : saldoZadarmaCentavos >= Math.round(costoPendiente),
    },
  });
});

/** Costo real por minuto de Zadarma para el país de una conexión. */
exports.costo = catchAsync(async (req, res) => {
  const id_configuracion = Number(req.query.id_configuracion);
  const [cfg] = id_configuracion
    ? await db.query(`SELECT pais FROM configuraciones WHERE id = ? LIMIT 1`, { replacements: [id_configuracion], type: db.QueryTypes.SELECT })
    : [null];
  try {
    const data = await zadarma.costoReferencia(cfg?.pais || req.query.pais || 'ec');
    return res.json({ status: 'success', data });
  } catch (e) {
    return responderError(res, e);
  }
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
