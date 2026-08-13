const crypto = require('crypto');
const catchAsync = require('../utils/catchAsync');
const AppError = require('../utils/appError');
const { encryptToken, decryptToken, last4 } = require('../utils/cryptoToken');
const AliclikIntegrations = require('../models/aliclik_integrations.model');
const Configuraciones = require('../models/configuraciones.model');
const aliclikService = require('../services/aliclik.service');

/**
 * URL pública del backend, para poder devolverle al cliente la dirección
 * completa que tiene que pegar en el panel de Aliclik.
 */
const PUBLIC_URL = (
  process.env.PUBLIC_BASE_URL ||
  process.env.APP_URL ||
  ''
).replace(/\/+$/, '');

function webhookUrl(secret) {
  const path = `/api/v1/aliclik_webhook/orders/${secret}`;
  return PUBLIC_URL ? `${PUBLIC_URL}${path}` : path;
}

function safeRow(row) {
  return {
    id: row.id,
    id_configuracion: row.id_configuracion,
    store_name: row.store_name,
    token_last4: row.token_last4,
    token_exp_at: row.token_exp_at,
    // Días que le quedan al token antes de que la API empiece a responder 401
    token_dias_restantes: diasRestantes(row.token_exp_at),
    company_id: row.company_id,
    integration_id: row.integration_id,
    webhook_url: webhookUrl(row.webhook_secret),
    is_active: row.is_active,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function diasRestantes(exp) {
  if (!exp) return null;
  const ms = new Date(exp).getTime() - Date.now();
  return Math.floor(ms / 86400000);
}

/**
 * Lee los claims del JWT de Aliclik sin verificar la firma (no tenemos su
 * secreto, y no hace falta: el token se usa contra su API, que sí lo valida).
 *
 * Interesa sobre todo `exp`: los tokens que emiten hoy duran 30 días, y cuando
 * vencen la API responde 401 y la cuenta deja de recibir estados en silencio.
 * Guardarlo permite avisar antes.
 */
function leerClaimsToken(token) {
  try {
    const parte = String(token).split('.')[1];
    if (!parte) return {};
    const json = Buffer.from(
      parte.replace(/-/g, '+').replace(/_/g, '/'),
      'base64',
    ).toString('utf8');
    const claims = JSON.parse(json);
    return {
      exp: claims?.exp ? new Date(claims.exp * 1000) : null,
      companyId: Number(claims?.companyId) || null,
      integrationId: Number(claims?.integrationId) || null,
    };
  } catch (_) {
    return {};
  }
}

async function assertConfigBelongsToOwner(req, id_configuracion) {
  const ownerId = req.sessionUser.id_usuario;
  const cfg = await Configuraciones.findOne({
    where: { id: id_configuracion, id_usuario: ownerId },
  });
  if (!cfg) {
    throw new AppError(
      'Configuración no válida o no pertenece a esta cuenta',
      403,
    );
  }
  return cfg;
}

/* ═══════════════════════════════════════════════════════════
   CRUD
   ═══════════════════════════════════════════════════════════ */

exports.list = catchAsync(async (req, res, next) => {
  const id_configuracion = Number(req.query.id_configuracion || 0);
  if (!id_configuracion)
    return next(new AppError('id_configuracion es requerido', 400));

  const rows = await AliclikIntegrations.findAll({
    where: { id_configuracion, deleted_at: null },
    order: [['id', 'DESC']],
  });

  return res.json({ isSuccess: true, data: rows.map(safeRow) });
});

exports.create = catchAsync(async (req, res, next) => {
  const { id_configuracion, store_name, token } = req.body;

  if (!id_configuracion || !store_name || !token) {
    return next(
      new AppError('id_configuracion, store_name y token son obligatorios', 400),
    );
  }

  const claims = leerClaimsToken(token);

  // El secreto del webhook se genera acá: es lo único que autentica los eventos
  // entrantes, así que tiene que ser impredecible y no derivarse del token.
  const secret = crypto.randomBytes(24).toString('hex');

  const created = await AliclikIntegrations.create({
    id_configuracion,
    store_name: String(store_name).trim(),
    token_enc: encryptToken(token),
    token_last4: last4(token),
    token_exp_at: claims.exp || null,
    company_id: claims.companyId || null,
    integration_id: claims.integrationId || null,
    webhook_secret: secret,
    is_active: 1,
    deleted_at: null,
  });

  return res.status(201).json({
    isSuccess: true,
    data: safeRow(created),
    // El cliente tiene que pegar esta URL en el panel de Aliclik, en
    // "Webhook de notificaciones".
    instrucciones:
      'Copia la webhook_url y pégala en el panel de Aliclik, en "Webhook de notificaciones".',
  });
});

exports.update = catchAsync(async (req, res, next) => {
  const { id } = req.params;

  const row = await AliclikIntegrations.findOne({
    where: { id, deleted_at: null },
  });
  if (!row) return next(new AppError('Integración no encontrada', 404));

  await assertConfigBelongsToOwner(req, row.id_configuracion);

  const { store_name, token, is_active } = req.body;

  if (store_name !== undefined) row.store_name = String(store_name).trim();

  if (token !== undefined && String(token).trim()) {
    const claims = leerClaimsToken(token);
    row.token_enc = encryptToken(token);
    row.token_last4 = last4(token);
    row.token_exp_at = claims.exp || null;
    row.company_id = claims.companyId || row.company_id;
    row.integration_id = claims.integrationId || row.integration_id;
  }

  if (is_active !== undefined) row.is_active = is_active ? 1 : 0;

  await row.save();

  return res.json({ isSuccess: true, data: safeRow(row) });
});

exports.remove = catchAsync(async (req, res, next) => {
  const { id } = req.params;

  const row = await AliclikIntegrations.findOne({
    where: { id, deleted_at: null },
  });
  if (!row) return next(new AppError('Integración no encontrada', 404));

  await assertConfigBelongsToOwner(req, row.id_configuracion);

  row.is_active = 0;
  row.deleted_at = new Date();
  await row.save();

  return res.json({ isSuccess: true, message: 'Integración eliminada' });
});

/**
 * Rota el secreto del webhook. Invalida la URL anterior de inmediato: hay que
 * pegar la nueva en el panel de Aliclik o dejan de llegar los estados.
 */
exports.rotarWebhookSecret = catchAsync(async (req, res, next) => {
  const { id } = req.params;

  const row = await AliclikIntegrations.findOne({
    where: { id, deleted_at: null },
  });
  if (!row) return next(new AppError('Integración no encontrada', 404));

  await assertConfigBelongsToOwner(req, row.id_configuracion);

  row.webhook_secret = crypto.randomBytes(24).toString('hex');
  await row.save();

  return res.json({
    isSuccess: true,
    data: safeRow(row),
    message:
      'Secreto rotado. Pega la nueva URL en el panel de Aliclik: la anterior ya no recibe eventos.',
  });
});

/**
 * Prueba la conexión contra Aliclik pidiendo una página mínima de pedidos.
 * Sirve para validar el token en el momento de vincular, en vez de que el
 * cliente se entere a la primera venta.
 */
exports.probarConexion = catchAsync(async (req, res, next) => {
  const { id } = req.params;

  const row = await AliclikIntegrations.findOne({
    where: { id, deleted_at: null },
  });
  if (!row) return next(new AppError('Integración no encontrada', 404));

  await assertConfigBelongsToOwner(req, row.id_configuracion);

  const token = decryptToken(row.token_enc);
  const data = await aliclikService.listOrders({
    token,
    params: { page: 1, limit: 1 },
  });

  return res.json({
    isSuccess: true,
    data: {
      ok: true,
      total_pedidos: data?.pagination?.total ?? null,
      token_exp_at: row.token_exp_at,
      token_dias_restantes: diasRestantes(row.token_exp_at),
      webhook_url: webhookUrl(row.webhook_secret),
    },
  });
});

exports.leerClaimsToken = leerClaimsToken;
