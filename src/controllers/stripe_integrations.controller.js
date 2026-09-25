const catchAsync = require('../utils/catchAsync');
const AppError = require('../utils/appError');
const { encryptToken, last4 } = require('../utils/cryptoToken');
const StripeIntegrations = require('../models/stripe_integrations.model');
const Configuraciones = require('../models/configuraciones.model');
const pagos = require('../services/pagos_stripe.service');

/**
 * Vinculación de la cuenta de Stripe PROPIA de cada configuración, para los
 * enlaces de pago del chat. Espeja a aliclik_integrations: llave cifrada con
 * cryptoToken, una vinculación por configuración, borrado lógico.
 */

function safeRow(row) {
  return {
    id: row.id,
    id_configuracion: row.id_configuracion,
    nombre: row.nombre,
    key_last4: row.key_last4,
    modo: row.modo,
    moneda_default: row.moneda_default,
    account_id: row.account_id,
    account_nombre: row.account_nombre,
    is_active: !!row.is_active,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

async function assertConfigBelongsToOwner(req, id_configuracion) {
  const cfg = await Configuraciones.findOne({
    where: { id: id_configuracion, id_usuario: req.sessionUser.id_usuario },
  });
  if (!cfg) {
    throw new AppError(
      'Configuración no válida o no pertenece a esta cuenta',
      403,
    );
  }
  return cfg;
}

// Los errores propios del servicio ya vienen explicados para el usuario; los
// de Stripe se resumen sin el texto técnico (endpoints, ids de cuenta).
const mensajeLlave = (e) =>
  e instanceof pagos.EnlacePagoError
    ? e.message
    : `Stripe rechazó la llave: ${e?.message || 'error desconocido'}`;

const MONEDAS = new Set([
  'usd',
  'eur',
  'mxn',
  'cop',
  'pen',
  'clp',
  'ars',
  'brl',
  'gtq',
]);
const normalizarMoneda = (m) => {
  const v = String(m || 'usd')
    .toLowerCase()
    .trim();
  return MONEDAS.has(v) ? v : 'usd';
};

/** GET /?id_configuracion — la vinculación (0 o 1 filas). */
exports.list = catchAsync(async (req, res, next) => {
  const id_configuracion = Number(req.query.id_configuracion || 0);
  if (!id_configuracion)
    return next(new AppError('id_configuracion es requerido', 400));
  const rows = await StripeIntegrations.findAll({
    where: { id_configuracion, deleted_at: null },
    order: [['id', 'DESC']],
  });
  return res.json({ isSuccess: true, data: rows.map(safeRow) });
});

/**
 * GET /estado?id_configuracion — lo mínimo que necesita el chat para mostrar
 * u ocultar "Crear enlace de pago". Cualquier subusuario de la cuenta.
 */
exports.estado = catchAsync(async (req, res, next) => {
  const id_configuracion = Number(req.query.id_configuracion || 0);
  if (!id_configuracion)
    return next(new AppError('id_configuracion es requerido', 400));
  const row = await pagos.integracionActiva(id_configuracion);
  return res.json({
    isSuccess: true,
    data: {
      activa: !!row,
      modo: row?.modo || null,
      moneda_default: row?.moneda_default || 'usd',
      monto_minimo: pagos.MONTO_MINIMO,
    },
  });
});

/** POST / — vincula (valida la llave contra Stripe antes de guardarla). */
exports.create = catchAsync(async (req, res, next) => {
  const { id_configuracion, nombre, secret_key, moneda_default } = req.body;
  if (!id_configuracion || !secret_key) {
    return next(
      new AppError('id_configuracion y secret_key son obligatorios', 400),
    );
  }
  const key = String(secret_key).trim();
  if (!/^(sk|rk)_(live|test)_[A-Za-z0-9]+$/.test(key)) {
    return next(
      new AppError(
        'La llave no tiene formato de Stripe (sk_live_…, rk_live_…, sk_test_… o rk_test_…).',
        400,
      ),
    );
  }

  const existente = await StripeIntegrations.findOne({
    where: { id_configuracion, deleted_at: null },
  });
  if (existente) {
    return next(
      new AppError(
        'Esta cuenta ya tiene Stripe vinculado. Edítalo o elimínalo primero.',
        409,
      ),
    );
  }

  let info;
  try {
    info = await pagos.validarLlave(key);
  } catch (e) {
    return next(new AppError(mensajeLlave(e), 400));
  }

  const created = await StripeIntegrations.create({
    id_configuracion,
    nombre: String(nombre || info.account_nombre || 'Mi cuenta de Stripe')
      .trim()
      .slice(0, 150),
    secret_key_enc: encryptToken(key),
    key_last4: last4(key),
    modo: info.modo,
    moneda_default: normalizarMoneda(moneda_default),
    account_id: info.account_id,
    account_nombre: info.account_nombre,
    is_active: 1,
    deleted_at: null,
  });
  pagos.olvidarCache(id_configuracion);

  return res.status(201).json({ isSuccess: true, data: safeRow(created) });
});

/** PATCH /:id — nombre, moneda, llave nueva o activar/desactivar. */
exports.update = catchAsync(async (req, res, next) => {
  const row = await StripeIntegrations.findOne({
    where: { id: req.params.id, deleted_at: null },
  });
  if (!row) return next(new AppError('Integración no encontrada', 404));
  await assertConfigBelongsToOwner(req, row.id_configuracion);

  const { nombre, secret_key, moneda_default, is_active } = req.body;
  if (nombre !== undefined) row.nombre = String(nombre).trim().slice(0, 150);
  if (moneda_default !== undefined)
    row.moneda_default = normalizarMoneda(moneda_default);
  if (is_active !== undefined) row.is_active = is_active ? 1 : 0;

  if (secret_key !== undefined && String(secret_key).trim()) {
    const key = String(secret_key).trim();
    if (!/^(sk|rk)_(live|test)_[A-Za-z0-9]+$/.test(key)) {
      return next(new AppError('La llave no tiene formato de Stripe.', 400));
    }
    let info;
    try {
      info = await pagos.validarLlave(key);
    } catch (e) {
      return next(new AppError(mensajeLlave(e), 400));
    }
    row.secret_key_enc = encryptToken(key);
    row.key_last4 = last4(key);
    row.modo = info.modo;
    row.account_id = info.account_id || row.account_id;
    row.account_nombre = info.account_nombre || row.account_nombre;
  }

  await row.save();
  pagos.olvidarCache(row.id_configuracion);
  return res.json({ isSuccess: true, data: safeRow(row) });
});

/** DELETE /:id — borrado lógico. Los enlaces ya creados se conservan. */
exports.remove = catchAsync(async (req, res, next) => {
  const row = await StripeIntegrations.findOne({
    where: { id: req.params.id, deleted_at: null },
  });
  if (!row) return next(new AppError('Integración no encontrada', 404));
  await assertConfigBelongsToOwner(req, row.id_configuracion);

  row.is_active = 0;
  row.deleted_at = new Date();
  await row.save();
  pagos.olvidarCache(row.id_configuracion);
  return res.json({ isSuccess: true, message: 'Stripe desvinculado' });
});

/** GET /:id/probar — vuelve a validar la llave guardada. */
exports.probarConexion = catchAsync(async (req, res, next) => {
  const row = await StripeIntegrations.findOne({
    where: { id: req.params.id, deleted_at: null },
  });
  if (!row) return next(new AppError('Integración no encontrada', 404));
  await assertConfigBelongsToOwner(req, row.id_configuracion);

  const { decryptToken } = require('../utils/cryptoToken');
  try {
    const info = await pagos.validarLlave(decryptToken(row.secret_key_enc));
    if (info.account_nombre && info.account_nombre !== row.account_nombre) {
      row.account_nombre = info.account_nombre;
      row.account_id = info.account_id || row.account_id;
      await row.save();
    }
    return res.json({ isSuccess: true, data: { ok: true, ...info } });
  } catch (e) {
    return res.json({
      isSuccess: true,
      data: { ok: false, error: e?.message || 'La llave ya no es válida' },
    });
  }
});
