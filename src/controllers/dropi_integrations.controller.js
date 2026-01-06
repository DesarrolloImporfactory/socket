const catchAsync = require('../utils/catchAsync');
const AppError = require('../utils/appError');

const DropiIntegrations = require('../models/dropi_integrations.model');
const Configuraciones = require('../models/configuraciones.model');

const { encryptToken, last4 } = require('../utils/cryptoToken');

function safeRow(row) {
  return {
    id: row.id,
    id_configuracion: row.id_configuracion,
    store_name: row.store_name,
    country_code: row.country_code,
    integration_key_last4: row.integration_key_last4,
    is_active: row.is_active,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/**
 * Valida que la configuración pertenece al dueño de la sesión.
 */
async function assertConfigBelongsToOwner(req, id_configuracion) {
  const ownerId = req.sessionUser.id_usuario;

  const cfg = await Configuraciones.findOne({
    where: {
      id: id_configuracion,
      id_usuario: ownerId,
    },
  });

  if (!cfg) {
    throw new AppError(
      'Configuración no válida o no pertenece a esta cuenta',
      403
    );
  }

  return cfg;
}

exports.create = catchAsync(async (req, res, next) => {
  const { id_configuracion, store_name, country_code, token } = req.body;

  if (!id_configuracion || !store_name || !country_code || !token) {
    return next(
      new AppError(
        'id_configuracion, store_name, country_code y token son obligatorios',
        400
      )
    );
  }

  await assertConfigBelongsToOwner(req, id_configuracion);

  const created = await DropiIntegrations.create({
    id_configuracion,
    store_name: String(store_name).trim(),
    country_code: String(country_code).trim().toUpperCase(),
    integration_key_enc: encryptToken(token),
    integration_key_last4: last4(token),
    is_active: 1,
    deleted_at: null,
  });

  return res.status(201).json({ isSuccess: true, data: safeRow(created) });
});

exports.list = catchAsync(async (req, res, next) => {
  const id_configuracion = Number(req.query.id_configuracion || 0);
  if (!id_configuracion)
    return next(new AppError('id_configuracion es requerido', 400));

  await assertConfigBelongsToOwner(req, id_configuracion);

  const rows = await DropiIntegrations.findAll({
    where: { id_configuracion, deleted_at: null, is_active: 1 },
    order: [['id', 'DESC']],
  });

  return res.json({ isSuccess: true, data: rows.map(safeRow) });
});

exports.update = catchAsync(async (req, res, next) => {
  const { id } = req.params;

  const row = await DropiIntegrations.findOne({
    where: { id, deleted_at: null },
  });
  if (!row) return next(new AppError('Integración no encontrada', 404));

  await assertConfigBelongsToOwner(req, row.id_configuracion);

  const { store_name, country_code, token, is_active } = req.body;

  if (store_name !== undefined) row.store_name = String(store_name).trim();
  if (country_code !== undefined)
    row.country_code = String(country_code).trim().toUpperCase();

  if (token !== undefined && String(token).trim()) {
    row.integration_key_enc = encryptToken(token);
    row.integration_key_last4 = last4(token);
  }

  if (is_active !== undefined) row.is_active = is_active ? 1 : 0;

  await row.save();

  return res.json({ isSuccess: true, data: safeRow(row) });
});

exports.remove = catchAsync(async (req, res, next) => {
  const { id } = req.params;

  const row = await DropiIntegrations.findOne({
    where: { id, deleted_at: null },
  });
  if (!row) return next(new AppError('Integración no encontrada', 404));

  await assertConfigBelongsToOwner(req, row.id_configuracion);

  row.is_active = 0;
  row.deleted_at = new Date();
  await row.save();

  return res.json({ isSuccess: true, message: 'Integración eliminada' });
});
