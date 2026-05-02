const catchAsync = require('../utils/catchAsync');
const AppError = require('../utils/appError');

const DropiIntegrations = require('../models/dropi_integrations.model');
const Configuraciones = require('../models/configuraciones.model');
const ClientesChatCenter = require('../models/clientes_chat_center.model');
const Sub_usuarios_chat_center = require('../models/sub_usuarios_chat_center.model');
const DropiOrdersCache = require('../models/dropi_orders_cache.model');
const { Op, fn, col, literal } = require('sequelize');
const { db } = require('../database/config');
const { encryptToken, last4, decryptToken } = require('../utils/cryptoToken');
const dropiService = require('../services/dropi.service');
const DropiDailyMetrics = require('../models/dropi_daily_metrics.model');

/* =========================
   Helpers
========================= */

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

/**
 * Obtiene la integración activa más reciente para una configuración.
 */
async function getActiveIntegration(id_configuracion) {
  return DropiIntegrations.findOne({
    where: { id_configuracion, deleted_at: null, is_active: 1 },
    order: [['id', 'DESC']],
  });
}

function toInt(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

function str(v) {
  if (v === null || v === undefined) return '';
  return String(v);
}

function strOrNull(v) {
  if (v === null || v === undefined) return null;
  const s = String(v);
  return s.trim().length ? s.trim() : null;
}

/**
 * Construye el payload EXCLUSIVAMENTE con el body que funciona en Postman.
 */
function buildDropiOrderPayload(body = {}) {
  const required = {
    type: strOrNull(body.type),
    type_service: strOrNull(body.type_service),
    rate_type: strOrNull(body.rate_type),

    total_order: toInt(body.total_order),
    shipping_amount: toInt(body.shipping_amount),
    payment_method_id: toInt(body.payment_method_id),

    name: strOrNull(body.name),
    surname: strOrNull(body.surname),
    phone: strOrNull(body.phone),

    country: strOrNull(body.country),
    state: strOrNull(body.state),
    city: strOrNull(body.city),
    dir: strOrNull(body.dir),

    products: Array.isArray(body.products) ? body.products : null,
  };

  const missing = [];
  for (const [k, v] of Object.entries(required)) {
    if (v === null || v === undefined || v === '' || (k === 'products' && !v)) {
      missing.push(k);
    }
  }

  if (missing.length) {
    throw new AppError(
      `Faltan campos requeridos para crear la orden en Dropi: ${missing.join(
        ', ',
      )}`,
      400,
    );
  }

  if (!Array.isArray(required.products) || required.products.length === 0) {
    throw new AppError('products debe ser un arreglo con al menos 1 item', 400);
  }

  const products = required.products.map((p, idx) => {
    const id = toInt(p?.id);
    const quantity = toInt(p?.quantity);
    const price = toInt(p?.price);

    if (!id) {
      throw new AppError(`products[${idx}].id es requerido`, 400);
    }
    if (!quantity || quantity <= 0) {
      throw new AppError(`products[${idx}].quantity inválido`, 400);
    }
    if (price === null || price < 0) {
      throw new AppError(`products[${idx}].price inválido`, 400);
    }

    return {
      id,
      name: str(p?.name),
      type: str(p?.type),

      variation_id:
        p?.variation_id === null || p?.variation_id === undefined
          ? null
          : toInt(p.variation_id),

      variations: Array.isArray(p?.variations) ? p.variations : [],

      quantity,
      price,

      sale_price: p?.sale_price ?? null,
      suggested_price: p?.suggested_price ?? null,
    };
  });

  const distributionCompany =
    body.distributionCompany && typeof body.distributionCompany === 'object'
      ? {
          id: toInt(body.distributionCompany.id),
          name: str(body.distributionCompany.name),
        }
      : null;

  return {
    type: required.type,
    type_service: required.type_service,
    rate_type: required.rate_type,

    total_order: required.total_order,
    shipping_amount: required.shipping_amount,
    payment_method_id: required.payment_method_id,

    notes: body.notes ?? '',

    name: required.name,
    surname: required.surname,
    phone: required.phone,
    client_email: body.client_email ?? '',

    country: required.country,
    state: required.state,
    city: required.city,
    dir: required.dir,
    zip_code: body.zip_code ?? null,
    colonia: body.colonia ?? '',

    dni: body.dni ?? '',
    dni_type: body.dni_type ?? '',

    insurance: body.insurance ?? null,
    shalom_data: body.shalom_data ?? null,

    distributionCompany: distributionCompany ?? null,

    products,
  };
}

function toIntOrDefault(v, def) {
  const n = toInt(v);
  return n === null ? def : n;
}

function buildDropiOrdersListParams(body = {}) {
  const result_number = toIntOrDefault(body.result_number, 10);
  const start = toIntOrDefault(body.start, 0);

  const filter_date_by = strOrNull(body.filter_date_by) || 'FECHA DE CREADO';
  const from = strOrNull(body.from);
  const until = strOrNull(body.until);
  const status = strOrNull(body.status);
  const textToSearch = strOrNull(body.textToSearch);

  if (!result_number || !result_number) {
    throw new AppError(
      'Filter_date_by y result_number son obligatorios para consultar órdenes',
      400,
    );
  }

  const params = {
    result_number: result_number + 1,
    start,
    filter_date_by,
    from,
    until,
  };

  if (status) params.status = status;
  if (textToSearch) params.textToSearch = textToSearch;

  return { params, requestedSize: result_number };
}

/* =========================
   CRUD Integrations
========================= */

exports.create = catchAsync(async (req, res, next) => {
  const { id_configuracion, store_name, country_code, token } = req.body;

  if (!id_configuracion || !store_name || !country_code || !token) {
    return next(
      new AppError(
        'id_configuracion, store_name, country_code y token son obligatorios',
        400,
      ),
    );
  }

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

exports.getMyIntegration = catchAsync(async (req, res, next) => {
  const id_usuario = req.sessionUser?.id_usuario;

  const integration = await DropiIntegrations.findOne({
    where: { id_usuario, deleted_at: null, is_active: 1 },
    attributes: [
      'id',
      'store_name',
      'country_code',
      'integration_key_last4',
      'created_at',
    ],
  });

  return res.json({ isSuccess: true, data: integration || null });
});

exports.createMyIntegration = catchAsync(async (req, res, next) => {
  const id_usuario = req.sessionUser?.id_usuario;
  const { store_name, country_code, integration_key } = req.body;

  if (!store_name || !country_code || !integration_key)
    return next(
      new AppError(
        'store_name, country_code e integration_key son requeridos',
        400,
      ),
    );

  // Desactivar integraciones anteriores del usuario
  await DropiIntegrations.update(
    { is_active: 0, deleted_at: new Date() },
    { where: { id_usuario, deleted_at: null } },
  );

  const nueva = await DropiIntegrations.create({
    id_usuario,
    id_configuracion: null,
    store_name: String(store_name).trim(),
    country_code: String(country_code).trim().toUpperCase(),
    integration_key_enc: encryptToken(integration_key),
    integration_key_last4: last4(integration_key),
    is_active: 1,
    deleted_at: null,
  });

  return res.status(201).json({ isSuccess: true, data: safeRow(nueva) });
});

exports.removeMyIntegration = catchAsync(async (req, res, next) => {
  const id_usuario = req.sessionUser?.id_usuario;
  const { id } = req.params;

  const row = await DropiIntegrations.findOne({
    where: { id, id_usuario, deleted_at: null },
  });

  if (!row)
    return next(
      new AppError('Integración no encontrada o no pertenece a tu cuenta', 404),
    );

  row.is_active = 0;
  row.deleted_at = new Date();
  await row.save();

  return res.json({
    isSuccess: true,
    message: 'Integración Dropi desvinculada correctamente',
  });
});

/* =========================
   Dropi: Crear Orden
========================= */

exports.createOrderMyOrders = catchAsync(async (req, res, next) => {
  const id_configuracion = toInt(req.body?.id_configuracion);
  if (!id_configuracion) {
    return next(new AppError('id_configuracion es requerido', 400));
  }

  const integration = await getActiveIntegration(id_configuracion);
  if (!integration) {
    return next(
      new AppError(
        'No existe una integración Dropi activa para esta configuración',
        404,
      ),
    );
  }

  const integrationKey = decryptToken(integration.integration_key_enc);
  if (!integrationKey || !String(integrationKey).trim()) {
    return next(new AppError('Dropi key inválida o no disponible', 400));
  }

  const raw = { ...req.body };
  delete raw.id_configuracion;

  let payload;
  try {
    payload = buildDropiOrderPayload(raw);
  } catch (e) {
    return next(e);
  }

  const dropiResponse = await dropiService.createOrderMyOrders({
    integrationKey,
    payload,
    country_code: integration.country_code,
  });

  return res.json({
    isSuccess: true,
    message: 'Orden enviada a Dropi correctamente',
    data: dropiResponse,
  });
});

// =========================
// Helpers para matching teléfono
// =========================
function digitsOnly(v) {
  return String(v || '').replace(/\D/g, '');
}

function phoneKeys(v) {
  const d = digitsOnly(v);
  if (!d) return [];
  const keys = [];

  if (d.length >= 9) keys.push(d.slice(-9));
  if (d.length >= 10) keys.push(d.slice(-10));

  return Array.from(new Set(keys));
}

// =========================
// Enriquecer órdenes (bulk)
// =========================
async function enrichOrdersWithChatAndAgent({ id_configuracion, objects }) {
  if (!Array.isArray(objects) || objects.length === 0) return objects;

  const allPhoneKeys = [];
  const phoneKeysByOrderId = new Map();

  for (const o of objects) {
    const ks = phoneKeys(o?.phone);
    if (ks.length) {
      ks.forEach((k) => allPhoneKeys.push(k));
      phoneKeysByOrderId.set(String(o?.id), ks);
    }
  }

  const uniqueKeys = Array.from(new Set(allPhoneKeys));
  if (uniqueKeys.length === 0) {
    return objects.map((o) => ({
      ...o,
      has_chat: false,
      tray: o?.phone ? String(o.phone) : 'Sin conversación',
      agent_assigned: 'Sin agente',
    }));
  }

  const orConditions = [];
  for (const k of uniqueKeys) {
    orConditions.push({ celular_cliente: { [Op.like]: `%${k}` } });
  }

  const clientes = await ClientesChatCenter.findAll({
    where: {
      id_configuracion,
      deleted_at: null,
      [Op.or]: orConditions,
    },
    attributes: ['id', 'celular_cliente', 'id_encargado', 'estado_contacto'],
    raw: true,
  });

  const clientByKey = new Map();
  for (const c of clientes) {
    const ks1 = phoneKeys(c?.celular_cliente);

    [...ks1].forEach((k) => {
      if (k && !clientByKey.has(k)) clientByKey.set(k, c);
    });
  }

  const encargadoIds = Array.from(
    new Set(
      clientes
        .map((c) => c?.id_encargado)
        .filter((x) => x !== null && x !== undefined && String(x).trim() !== '')
        .map((x) => Number(x))
        .filter((x) => Number.isFinite(x)),
    ),
  );

  let subusersById = new Map();
  if (encargadoIds.length) {
    const subs = await Sub_usuarios_chat_center.findAll({
      where: { id_sub_usuario: { [Op.in]: encargadoIds } },
      attributes: ['id_sub_usuario', 'nombre_encargado'],
      raw: true,
    });

    subusersById = new Map(
      subs.map((s) => [String(s.id_sub_usuario), s.nombre_encargado]),
    );
  }

  const enriched = objects.map((o) => {
    const ks = phoneKeysByOrderId.get(String(o?.id)) || [];
    let client = null;

    for (const k of ks) {
      const found = clientByKey.get(k);
      if (found) {
        client = found;
        break;
      }
    }

    const has_chat = !!client;

    const tray = has_chat
      ? client?.estado_contacto
        ? String(client.estado_contacto)
        : 'contacto_inicial'
      : 'No hay conversación';

    const agentName = has_chat
      ? client?.id_encargado
        ? subusersById.get(String(client.id_encargado)) || 'Sin agente'
        : 'Sin agente'
      : 'Sin agente';

    return {
      ...o,
      has_chat,
      tray,
      agent_assigned: agentName,
      chat_id_cliente: client?.id || null,
      chat_id_encargado: client?.id_encargado || null,
    };
  });

  return enriched;
}

exports.listMyOrders = catchAsync(async (req, res, next) => {
  const id_configuracion = toInt(req.body?.id_configuracion);
  if (!id_configuracion) {
    return next(new AppError('id_configuracion es requerido', 400));
  }

  const integration = await getActiveIntegration(id_configuracion);
  if (!integration) {
    return next(
      new AppError(
        'No existe una integración Dropi activa para esta configuración',
        404,
      ),
    );
  }

  const integrationKey = decryptToken(integration.integration_key_enc);

  if (!integrationKey || !String(integrationKey).trim()) {
    return next(new AppError('Dropi key inválida o no disponible', 400));
  }

  const raw = { ...req.body };
  delete raw.id_configuracion;

  let paramsResult;
  try {
    paramsResult = buildDropiOrdersListParams(raw);
  } catch (e) {
    return next(e);
  }

  const { params, requestedSize } = paramsResult;

  console.log('📤 Params enviados a Dropi:', JSON.stringify(params));

  let dropiResponse;
  try {
    dropiResponse = await dropiService.listMyOrders({
      integrationKey,
      params,
      country_code: integration.country_code,
    });
  } catch (err) {
    console.error('❌ Error completo de Dropi:');
    console.error('  Status:', err?.statusCode || err?.status);
    console.error('  Message:', err?.message);
    console.error('  Stack:', err?.stack);
    return next(err);
  }

  const objects = dropiResponse?.objects || dropiResponse?.data?.objects || [];
  const enrichedObjects = await enrichOrdersWithChatAndAgent({
    id_configuracion,
    objects,
  });

  const hasMore = enrichedObjects.length > requestedSize;
  const trimmed = hasMore
    ? enrichedObjects.slice(0, requestedSize)
    : enrichedObjects;

  const final = {
    ...dropiResponse,
    objects: trimmed,
    hasMore,
  };

  return res.json({
    isSuccess: true,
    data: final,
  });
});

exports.listProductsIndex = catchAsync(async (req, res, next) => {
  const id_configuracion = toInt(req.body?.id_configuracion);
  if (!id_configuracion)
    return next(new AppError('id_configuracion es requerido', 400));

  const integration = await getActiveIntegration(id_configuracion);
  if (!integration)
    return next(new AppError('No existe una integración Dropi activa', 404));

  const integrationKey = decryptToken(integration.integration_key_enc);
  if (!integrationKey) return next(new AppError('Dropi key inválida', 400));

  const payload = {
    pageSize: toInt(req.body?.pageSize) || 50,
    startData: toInt(req.body?.startData) ?? 0,
    no_count: req.body?.no_count === false ? false : true,
    order_by: strOrNull(req.body?.order_by) || 'id',
    order_type: strOrNull(req.body?.order_type) || 'asc',
    keywords: str(req.body?.keywords || ''),
  };

  if (Array.isArray(req.body?.category) && req.body.category.length) {
    payload.category = req.body.category;
  }
  if (typeof req.body?.favorite === 'boolean')
    payload.favorite = req.body.favorite;
  if (typeof req.body?.privated_product === 'boolean')
    payload.privated_product = req.body.privated_product;

  const dropiResponse = await dropiService.listProductsIndex({
    integrationKey,
    payload,
    country_code: integration.country_code,
  });

  return res.json({ isSuccess: true, data: dropiResponse });
});

exports.listStates = catchAsync(async (req, res, next) => {
  const id_configuracion = toInt(req.query?.id_configuracion);
  const country_id = toInt(req.query?.country_id) ?? 1;

  if (!id_configuracion)
    return next(new AppError('id_configuracion es requerido', 400));

  const integration = await getActiveIntegration(id_configuracion);
  if (!integration)
    return next(new AppError('No existe una integración Dropi activa', 404));

  const integrationKey = decryptToken(integration.integration_key_enc);
  if (!integrationKey) return next(new AppError('Dropi key inválida', 400));

  const dropiResponse = await dropiService.listStates({
    integrationKey,
    country_id,
    country_code: integration.country_code,
  });

  return res.json({ isSuccess: true, data: dropiResponse });
});

exports.listCities = catchAsync(async (req, res, next) => {
  const id_configuracion = toInt(req.body?.id_configuracion);
  const department_id = toInt(req.body?.department_id);
  const rate_type = strOrNull(req.body?.rate_type);

  if (!id_configuracion)
    return next(new AppError('id_configuracion es requerido', 400));
  if (!department_id)
    return next(new AppError('department_id es requerido', 400));
  if (!rate_type) return next(new AppError('COD es requerido', 400));

  const integration = await getActiveIntegration(id_configuracion);
  if (!integration)
    return next(new AppError('No existe una integración Dropi activa', 404));

  const integrationKey = decryptToken(integration.integration_key_enc);
  if (!integrationKey) return next(new AppError('Dropi key inválida', 400));

  const payload = { department_id, rate_type };

  const dropiResponse = await dropiService.listCities({
    integrationKey,
    payload,
    country_code: integration.country_code,
  });

  return res.json({ isSuccess: true, data: dropiResponse });
});

exports.getSyncConfig = catchAsync(async (req, res, next) => {
  const id_configuracion = toInt(req.query?.id_configuracion);
  if (!id_configuracion)
    return next(new AppError('id_configuracion es requerido', 400));

  const integration = await getActiveIntegration(id_configuracion);
  if (!integration)
    return next(new AppError('No existe una integración Dropi activa', 404));

  return res.json({
    isSuccess: true,
    data: {
      sync_stock: integration.sync_stock ?? 0,
      sync_sale_price: integration.sync_sale_price ?? 0,
      sync_suggested_price: integration.sync_suggested_price ?? 0,
    },
  });
});

exports.updateSyncConfig = catchAsync(async (req, res, next) => {
  const id_configuracion = toInt(req.body?.id_configuracion);
  if (!id_configuracion)
    return next(new AppError('id_configuracion es requerido', 400));

  const integration = await getActiveIntegration(id_configuracion);
  if (!integration)
    return next(new AppError('No existe una integración Dropi activa', 404));

  const { sync_stock, sync_sale_price, sync_suggested_price } = req.body;

  const updates = {};
  if (sync_stock !== undefined) updates.sync_stock = sync_stock ? 1 : 0;
  if (sync_sale_price !== undefined)
    updates.sync_sale_price = sync_sale_price ? 1 : 0;
  if (sync_suggested_price !== undefined)
    updates.sync_suggested_price = sync_suggested_price ? 1 : 0;

  if (!Object.keys(updates).length)
    return next(new AppError('No se enviaron campos para actualizar', 400));

  await DropiIntegrations.update(updates, {
    where: { id: integration.id },
  });

  return res.json({
    isSuccess: true,
    data: {
      sync_stock: updates.sync_stock ?? integration.sync_stock,
      sync_sale_price: updates.sync_sale_price ?? integration.sync_sale_price,
      sync_suggested_price:
        updates.sync_suggested_price ?? integration.sync_suggested_price,
    },
  });
});

exports.listAllMyIntegrations = catchAsync(async (req, res, next) => {
  const id_usuario = req.sessionUser?.id_usuario;
  if (!id_usuario) return next(new AppError('No autenticado', 401));

  const [rows] = await db.query(
    `SELECT di.id,
            di.id_configuracion,
            di.id_usuario,
            di.store_name,
            di.country_code,
            di.integration_key_last4,
            di.is_active,
            di.created_at,
            c.nombre_configuracion,
            c.telefono
     FROM dropi_integrations di
     LEFT JOIN configuraciones c ON c.id = di.id_configuracion
     WHERE di.is_active = 1
       AND di.deleted_at IS NULL
       AND (
         di.id_usuario = :id_usuario
         OR di.id_configuracion IN (
           SELECT id FROM configuraciones WHERE id_usuario = :id_usuario
         )
       )
     ORDER BY di.created_at DESC`,
    { replacements: { id_usuario } },
  );

  const data = (rows || []).map((r) => ({
    id: r.id,
    id_configuracion: r.id_configuracion,
    id_usuario: r.id_usuario,
    store_name: r.store_name,
    country_code: r.country_code,
    integration_key_last4: r.integration_key_last4,
    type: r.id_configuracion ? 'config' : 'user',
    label: r.id_configuracion
      ? `${r.store_name} — ${r.nombre_configuracion || r.telefono || `Config #${r.id_configuracion}`}`
      : `${r.store_name} (Mi cuenta)`,
    nombre_configuracion: r.nombre_configuracion || null,
    telefono: r.telefono || null,
  }));

  return res.json({ isSuccess: true, data });
});

/* =========================
   Dashboard: Cache + Stats
========================= */

// Tracking en memoria
if (!global._dropiSyncDone) global._dropiSyncDone = {};
if (!global._dropiSyncLock) global._dropiSyncLock = {};
if (!global._profitSyncLock) global._profitSyncLock = {};

// ── Clasificar status Dropi ──
function classifyDropiStatus(status) {
  const s = String(status || '')
    .trim()
    .toUpperCase();

  // ENTREGADA
  if (
    s === 'ENTREGADO' ||
    s.includes('ENTREGADA') ||
    s === 'REPORTADO ENTREGADO' ||
    s.includes('REPORTADO ENTREGADO') ||
    s === 'ENTREGA DIGITALIZADA' ||
    s === 'CERTIFICACION DE PRUEBA DE ENTREGA'
  )
    return 'entregada';

  // DEVOLUCION
  if (
    s.includes('DEVOLUCION') ||
    s.includes('DEVOLUCIÓN') ||
    s === 'DEVUELTO' ||
    s === 'CERTIFICACION DEVOLUCION AL REMITENTE' ||
    s === 'DESAPLICADO'
  )
    return 'devolucion';

  // CANCELADA
  if (
    s === 'CANCELADO' ||
    s.includes('CANCELADA') ||
    s === 'ANULADA' ||
    s === 'RECHAZADO' ||
    s === 'GUIA_ANULADA'
  )
    return 'cancelada';

  // PENDIENTE
  if (s === 'PENDIENTE' || s === 'PENDIENTE CONFIRMACION') return 'pendiente';

  // RETIRO EN AGENCIA
  if (
    s.includes('RETIRO EN AGENCIA') ||
    s.includes('ENVÍO LISTO EN OFICINA') ||
    s === 'ENVIO LISTO EN OFICINA'
  )
    return 'retiro_agencia';

  // NOVEDAD
  if (
    s.includes('NOVEDAD') ||
    s.includes('SOLUCION') ||
    s.includes('SOLUCIÓN') ||
    s === 'CON NOVEDAD' ||
    s === 'DESTINATARIO FALLECIDO' ||
    s.includes('DESTINATARIO RE-PROGRAMA') ||
    s.includes('DESTINATARIO SOLICITA') ||
    s.includes('DESTINATARIO INDICA') ||
    s.includes('FUERA DE COBERTURA') ||
    s.includes('OBSTRUCCIÓN EN LA VÍA') ||
    s.includes('PROBLEMAS DE ORDEN') ||
    s.includes('VISITA A DESTINATARIO') ||
    s.includes('ACCIDENTE EN CARRETERA') ||
    s.includes('EN ESPERA DE FIRMA') ||
    s.includes('INCONFORME')
  )
    return 'novedad';

  // INDEMNIZADA
  if (
    s.includes('INDEMNIZ') ||
    s.includes('SINIESTRO') ||
    s.includes('INCAUTADO') ||
    s.includes('HURTAD') ||
    s.includes('AVERÍA')
  )
    return 'indemnizada';

  // GUIA GENERADA — guía recién creada, aún no se mueve
  if (s === 'GUIA_GENERADA') return 'guia_generada';

  // EN REPARTO — last-mile real (próximo a entregar al cliente)
  if (
    s === 'EN REPARTO' || // GINTRACOM
    s === 'ZONA DE ENTREGA' || // LAAR
    s === 'EN DISTRIBUCION A CLIENTE' || // SERVIENTREGA (sin tilde)
    s === 'EN DISTRIBUCIÓN A CLIENTE' || // SERVIENTREGA (con tilde)
    s.includes('EN DISTRIBUCION A') ||
    s.includes('EN DISTRIBUCIÓN A') ||
    s === 'EN CAMINO' || // VELOCES
    s.includes('SALIDA A REPARTO') ||
    s.includes('REPARTIDOR ASIGNADO')
  )
    return 'en_reparto';

  // EN TRANSITO — todo lo demás del flujo logístico interno
  if (
    s.includes('TRÁNSITO') ||
    s.includes('TRANSITO') ||
    s.includes('EN RUTA') ||
    s.includes('BODEGA') ||
    s.includes('EMBARCANDO') ||
    s.includes('RECOLECT') ||
    s.includes('RECOGIDO') ||
    s.includes('ASIGNADO') ||
    s.includes('PICKING') ||
    s.includes('PACKING') ||
    s.includes('GENERADO') ||
    s.includes('GENERADA') ||
    s.includes('PREPARADO') ||
    s.includes('INVENTARIO') ||
    s.includes('INGRES') ||
    s.includes('RECIBIDO') ||
    s === 'POR RECOLECTAR' ||
    s === 'PROCESAMIENTO'
  )
    return 'en_transito';

  return 'otro';
}

/* ═══════════════════════════════════════════════════════════
   Cache context helpers
   cacheCtx = { id_configuracion: X } | { id_usuario: Y }
   ═══════════════════════════════════════════════════════════ */

/**
 * WHERE clause para filtrar cache.
 * Config-level: { id_configuracion: X, id_usuario: 0 }
 * User-level:   { id_configuracion: 0, id_usuario: Y }
 */
function buildCacheWhere(cacheCtx) {
  if (cacheCtx.id_configuracion) {
    return { id_configuracion: cacheCtx.id_configuracion, id_usuario: 0 };
  }
  return { id_configuracion: 0, id_usuario: cacheCtx.id_usuario };
}

/**
 * Campos para INSERT/upsert.
 */
function buildCacheInsert(cacheCtx) {
  return {
    id_configuracion: cacheCtx.id_configuracion || 0,
    id_usuario: cacheCtx.id_usuario || 0,
  };
}

/**
 * String key para sync locks y tracking.
 */
function buildCacheKey(cacheCtx) {
  if (cacheCtx.id_configuracion) return `c_${cacheCtx.id_configuracion}`;
  return `u_${cacheCtx.id_usuario}`;
}

/**
 * Computa el alertLevel de devolución para una orden.
 * Se usa en upsertOrdersToCache y syncDevolutionDetails.
 */
function computeDevolutionAlert(orderObj) {
  if (classifyDropiStatus(orderObj.status) !== 'devolucion') return null;

  const movements = orderObj.servientrega_movements || [];
  const history = orderObj.history || [];

  if (movements.length > 0) {
    const hasBS = movements.some((m) =>
      String(m.nom_mov || '')
        .toUpperCase()
        .includes('DEV CONFIRMADA POR BODEGA'),
    );
    const hasDR = movements.some((m) => {
      const u = String(m.nom_mov || '').toUpperCase();
      return (
        u.includes('DEVOLUCION AL REMITENTE') ||
        u.includes('DEVOLUCIÓN AL REMITENTE')
      );
    });
    if (hasBS) return 'ok';
    if (hasDR) return 'critical';
    return 'pending';
  }

  if (history.length > 0) {
    const hasBSH = history.some((h) =>
      String(h.status || '')
        .toUpperCase()
        .includes('DEV CONFIRMADA POR BODEGA'),
    );
    const hasDRH = history.some((h) => {
      const s = String(h.status || '').toUpperCase();
      return (
        s.includes('DEVOLUCION AL REMITENTE') ||
        s.includes('DEVOLUCIÓN AL REMITENTE')
      );
    });
    if (hasBSH) return 'ok';
    if (hasDRH) return 'critical';
    return 'unverifiable';
  }

  // Sin movements ni history → unverifiable (pendiente de syncDevolutionDetails)
  return 'unverifiable';
}

/* ═══════════════════════════════════════════════════════════
   Upsert órdenes en cache
   ═══════════════════════════════════════════════════════════ */

async function upsertOrdersToCache(cacheCtx, orders) {
  if (!orders.length) return;

  const insertFields = buildCacheInsert(cacheCtx);

  const bulkData = orders.map((o) => {
    const details = Array.isArray(o.orderdetails) ? o.orderdetails : [];
    const productNames = details.map((d) => d?.product?.name).filter(Boolean);

    return {
      dropi_order_id: o.id,
      ...insertFields,
      status: o.status || null,
      classified_status: classifyDropiStatus(o.status),
      total_order: Number(o.total_order || 0),
      name: o.name || null,
      surname: o.surname || null,
      phone: o.phone || null,
      city: o.city || null,
      shipping_company: o.shipping_company || null,
      shipping_guide: o.shipping_guide || null,
      product_names: JSON.stringify(productNames),
      order_created_at: o.created_at || null,
      order_data: JSON.stringify(o),
      synced_at: new Date(),
      devolution_alert: computeDevolutionAlert(o),
    };
  });

  for (let i = 0; i < bulkData.length; i += 200) {
    const batch = bulkData.slice(i, i + 200);
    await DropiOrdersCache.bulkCreate(batch, {
      updateOnDuplicate: [
        'status',
        'classified_status',
        'total_order',
        'name',
        'surname',
        'phone',
        'city',
        'shipping_company',
        'shipping_guide',
        'product_names',
        'order_data',
        'synced_at',
        'devolution_alert',
      ],
    });
  }

  console.log(
    `[cache] Upserted ${bulkData.length} orders for ${buildCacheKey(cacheCtx)}`,
  );
}

/* ═══════════════════════════════════════════════════════════
   Sync desde Dropi
   ═══════════════════════════════════════════════════════════ */

async function syncFromDropi({
  integrationKey,
  country_code,
  cacheCtx,
  from,
  until,
}) {
  const lockKey = buildCacheKey(cacheCtx);
  const syncKey = `${lockKey}_${from}_${until}`;
  const cacheWhere = buildCacheWhere(cacheCtx);

  if (global._dropiSyncLock[lockKey]) {
    console.log(`[cache] Sync already running for ${lockKey}, skipping`);
    return { synced: false, reason: 'locked' };
  }
  global._dropiSyncLock[lockKey] = true;

  try {
    const lastSync = await DropiOrdersCache.findOne({
      where: {
        ...cacheWhere,
        order_created_at: {
          [Op.between]: [`${from} 00:00:00`, `${until} 23:59:59`],
        },
      },
      order: [['synced_at', 'DESC']],
      attributes: ['synced_at'],
    });

    const lastSyncTime = lastSync?.synced_at || null;
    const now = new Date();

    if (lastSyncTime) {
      const diffMinutes = (now - new Date(lastSyncTime)) / (1000 * 60);
      if (diffMinutes < 10) {
        console.log(
          `[cache] Skipping sync — last sync was ${diffMinutes.toFixed(1)}min ago`,
        );
        global._dropiSyncDone[syncKey] = { at: Date.now(), count: -1 };

        syncProfitDetails({
          integrationKey,
          country_code,
          cacheCtx,
          from,
          until,
        }).catch((err) =>
          console.error('[profit] Background profit sync error:', err?.message),
        );

        syncDevolutionDetails({
          integrationKey,
          country_code,
          cacheCtx,
          from,
          until,
        }).catch((err) =>
          console.error(
            '[dev-sync] Background devolution sync error:',
            err?.message,
          ),
        );

        return { synced: false, reason: 'recent' };
      }
    }

    const filterDateBy = lastSyncTime
      ? 'FECHA DE CAMBIO DE ESTATUS'
      : 'FECHA DE CREADO';

    let allOrders = [];
    let start = 0;
    let keepGoing = true;
    const PAGE_SIZE = 100;
    let currentDelay = 2500;
    let consecutiveRetries = 0;

    console.log(
      `[cache] Syncing from Dropi: ${filterDateBy} from=${from} until=${until} (${lockKey})`,
    );

    while (keepGoing) {
      try {
        const dropiResponse = await dropiService.listMyOrders({
          integrationKey,
          params: {
            result_number: PAGE_SIZE,
            start,
            filter_date_by: filterDateBy,
            from,
            until,
          },
          country_code,
        });

        const objects = dropiResponse?.objects || [];
        allOrders = allOrders.concat(objects);

        keepGoing = objects.length >= PAGE_SIZE;
        start += PAGE_SIZE;

        if (allOrders.length >= 5000) break;
        currentDelay = 2500;
        consecutiveRetries = 0;
        if (keepGoing) await new Promise((r) => setTimeout(r, currentDelay));
      } catch (err) {
        const status = err?.statusCode || err?.status || 500;
        if (status === 429) {
          consecutiveRetries++;
          if (consecutiveRetries >= 5) {
            keepGoing = false;
            break;
          }
          currentDelay = Math.min(currentDelay * 2, 15000);
          console.log(
            `[cache] 429 Rate limited (retry ${consecutiveRetries}/5). Waiting ${currentDelay}ms...`,
          );
          await new Promise((r) => setTimeout(r, currentDelay));
          continue;
        }
        console.error(`[cache] Dropi error at start=${start}: ${err?.message}`);
        keepGoing = false;
      }
    }

    if (allOrders.length > 0) {
      await upsertOrdersToCache(cacheCtx, allOrders);
    }

    global._dropiSyncDone[syncKey] = {
      at: Date.now(),
      count: allOrders.length,
    };

    console.log(
      `[cache] Sync complete: ${allOrders.length} orders synced (key=${syncKey})`,
    );

    syncProfitDetails({
      integrationKey,
      country_code,
      cacheCtx,
      from,
      until,
    }).catch((err) =>
      console.error('[profit] Background profit sync error:', err?.message),
    );

    syncDevolutionDetails({
      integrationKey,
      country_code,
      cacheCtx,
      from,
      until,
    }).catch((err) =>
      console.error(
        '[dev-sync] Background devolution sync error:',
        err?.message,
      ),
    );

    return { synced: true, count: allOrders.length };
  } finally {
    global._dropiSyncLock[lockKey] = false;
  }
}

/* ═══════════════════════════════════════════════════════════
   Sync profit details
   ═══════════════════════════════════════════════════════════ */

async function syncProfitDetails({
  integrationKey,
  country_code,
  cacheCtx,
  from,
  until,
}) {
  const lockKey = buildCacheKey(cacheCtx);
  const cacheWhere = buildCacheWhere(cacheCtx);

  if (global._profitSyncLock[lockKey]) {
    console.log(`[profit] Already running for ${lockKey}, skipping`);
    return { calculated: 0, skipped: true, reason: 'locked' };
  }

  global._profitSyncLock[lockKey] = true;

  try {
    const pending = await DropiOrdersCache.findAll({
      where: {
        ...cacheWhere,
        dropshipper_profit: null,
        order_created_at: {
          [Op.between]: [`${from} 00:00:00`, `${until} 23:59:59`],
        },
      },
      attributes: ['id', 'dropi_order_id'],
      limit: 50,
      order: [['id', 'ASC']],
    });

    if (!pending.length) {
      console.log(`[profit] No pending orders for ${lockKey}`);
      return { calculated: 0, pending: 0 };
    }

    console.log(
      `[profit] Calculating profit for ${pending.length} orders (${lockKey})`,
    );

    let calculated = 0;
    let errors = 0;

    for (let idx = 0; idx < pending.length; idx++) {
      const order = pending[idx];
      try {
        const detail = await dropiService.getOrderDetail({
          integrationKey,
          orderId: order.dropi_order_id,
          country_code,
        });

        const profit = detail?.objects?.dropshipper_amount_to_win;

        if (idx === 0 && (profit === null || profit === undefined)) {
          console.log(
            `[profit] No dropshipper_amount_to_win found — likely proveedor account. Marking all as 0.`,
          );
          await DropiOrdersCache.update(
            { dropshipper_profit: 0 },
            {
              where: {
                ...cacheWhere,
                dropshipper_profit: null,
              },
            },
          );
          return { calculated: 0, skipped: true, reason: 'proveedor' };
        }

        await DropiOrdersCache.update(
          { dropshipper_profit: Number(profit || 0) },
          { where: { id: order.id } },
        );
        calculated++;

        await new Promise((r) => setTimeout(r, 2500));
      } catch (err) {
        const status = err?.response?.status || err?.statusCode || 500;
        if (status === 429) {
          console.log('[profit] Rate limited, stopping this batch');
          break;
        }
        console.error(
          `[profit] Error order ${order.dropi_order_id}: ${err?.message}`,
        );
        errors++;
        if (errors >= 5) {
          console.log('[profit] Too many errors, stopping batch.');
          break;
        }
        await new Promise((r) => setTimeout(r, 3000));
      }
    }

    console.log(`[profit] Done: ${calculated} calculated, ${errors} errors`);
    return { calculated, errors, total: pending.length };
  } finally {
    global._profitSyncLock[lockKey] = false;
  }
}

/* ═══════════════════════════════════════════════════════════
   Sync devolution details
   ─────────────────────────────────────────────────────────
   Dos grupos:
   1) Sin movements NI history → necesitan data inicial
   2) Critical → re-check por si recibieron "DEV CONFIRMADA
      POR BODEGA" después del sync original.
   
   Filtros para no saturar API:
   - Solo critical (no ok/pending/unverifiable)
   - Cooldown 48h por orden (dev_recheck_at)
   - Bloques de 10 con pausa de 15s entre bloques
   ═══════════════════════════════════════════════════════════ */

if (!global._devSyncLock) global._devSyncLock = {};

async function syncDevolutionDetails({
  integrationKey,
  country_code,
  cacheCtx,
  from,
  until,
}) {
  const lockKey = buildCacheKey(cacheCtx);
  const cacheWhere = buildCacheWhere(cacheCtx);

  if (global._devSyncLock[lockKey]) {
    console.log(`[dev-sync] Already running for ${lockKey}, skipping`);
    return { updated: 0, skipped: true };
  }

  global._devSyncLock[lockKey] = true;

  try {
    const devRows = await DropiOrdersCache.findAll({
      where: {
        ...cacheWhere,
        classified_status: 'devolucion',
        order_created_at: {
          [Op.between]: [`${from} 00:00:00`, `${until} 23:59:59`],
        },
      },
      attributes: [
        'id',
        'dropi_order_id',
        'order_data',
        'devolution_alert',
        'dev_recheck_at',
      ],
      raw: true,
    });

    const now = new Date();

    // ── Grupo 1: Sin movements NI history → necesitan data inicial ──
    const withoutData = devRows.filter((row) => {
      try {
        const od = JSON.parse(row.order_data || '{}');
        const movements = od.servientrega_movements || [];
        const history = od.history || [];
        return movements.length === 0 && history.length === 0;
      } catch {
        return true;
      }
    });

    // ── Grupo 2: Critical con movements → re-check si pasó cooldown 48h ──
    const criticalRecheck = devRows.filter((row) => {
      if (row.devolution_alert !== 'critical') return false;

      // Si no tiene movements, ya cayó en grupo 1
      try {
        const od = JSON.parse(row.order_data || '{}');
        if (
          (od.servientrega_movements || []).length === 0 &&
          (od.history || []).length === 0
        )
          return false;
      } catch {
        return false;
      }

      // Cooldown 48h
      if (row.dev_recheck_at) {
        const hoursSinceRecheck =
          (now - new Date(row.dev_recheck_at)) / (1000 * 60 * 60);
        if (hoursSinceRecheck < 48) return false;
      }

      return true;
    });

    const finalBatch = [...withoutData, ...criticalRecheck];

    if (!finalBatch.length) {
      console.log(
        `[dev-sync] Nothing to refresh for ${lockKey} ` +
          `(${devRows.length} devolutions, ${criticalRecheck.length} critical eligible)`,
      );
      return { updated: 0, total: devRows.length, criticalEligible: 0 };
    }

    console.log(
      `[dev-sync] Refreshing ${finalBatch.length} orders for ${lockKey} ` +
        `(${withoutData.length} sin data + ${criticalRecheck.length} critical recheck)`,
    );

    let updated = 0;
    let errors = 0;

    for (let i = 0; i < finalBatch.length; i++) {
      const row = finalBatch[i];

      // ── Pausa extra cada 10 órdenes para no saturar API ──
      if (i > 0 && i % 10 === 0) {
        console.log(
          `[dev-sync] Bloque ${i / 10} completado (${updated} updated), pausa 15s...`,
        );
        await new Promise((r) => setTimeout(r, 15000));
      }

      try {
        const detail = await dropiService.getOrderDetail({
          integrationKey,
          orderId: row.dropi_order_id,
          country_code,
        });

        const freshOrder = detail?.objects;
        if (!freshOrder) {
          errors++;
          // Marcar recheck para no reintentar en 48h
          if (row.devolution_alert === 'critical') {
            await DropiOrdersCache.update(
              { dev_recheck_at: now },
              { where: { id: row.id } },
            );
          }
          continue;
        }

        const freshHistory = freshOrder.history || [];
        const freshMovements = freshOrder.servientrega_movements || [];
        const isCriticalRecheck = row.devolution_alert === 'critical';
        const hasNewData = freshHistory.length > 0 || freshMovements.length > 0;

        if (hasNewData || isCriticalRecheck) {
          let existingOd = {};
          try {
            existingOd = JSON.parse(row.order_data || '{}');
          } catch {
            existingOd = {};
          }

          // Siempre reemplazar con data fresca (puede tener nuevos movements)
          if (freshMovements.length > 0) {
            existingOd.servientrega_movements = freshMovements;
          }
          if (freshHistory.length > 0) {
            existingOd.history = freshHistory;
          }
          if (freshOrder.managed_devolution_app !== undefined) {
            existingOd.managed_devolution_app =
              freshOrder.managed_devolution_app;
          }

          const newAlert = computeDevolutionAlert(existingOd);

          await DropiOrdersCache.update(
            {
              order_data: JSON.stringify(existingOd),
              devolution_alert: newAlert,
              synced_at: now,
              dev_recheck_at: now,
            },
            { where: { id: row.id } },
          );

          if (newAlert !== row.devolution_alert) {
            console.log(
              `[dev-sync] Order ${row.dropi_order_id}: ${row.devolution_alert} → ${newAlert}`,
            );
          }

          updated++;
        } else if (isCriticalRecheck) {
          // Sin data nueva pero marcamos recheck para cooldown 48h
          await DropiOrdersCache.update(
            { dev_recheck_at: now },
            { where: { id: row.id } },
          );
        }

        await new Promise((r) => setTimeout(r, 2500));
      } catch (err) {
        const status = err?.response?.status || err?.statusCode || 500;
        if (status === 429) {
          console.log('[dev-sync] Rate limited, pausa 30s...');
          await new Promise((r) => setTimeout(r, 30000));
          i--; // reintentar la misma orden
          errors++;
          if (errors >= 10) {
            console.log('[dev-sync] Demasiados 429, cortando batch');
            break;
          }
          continue;
        }
        console.error(
          `[dev-sync] Error order ${row.dropi_order_id}: ${err?.message}`,
        );
        errors++;
        if (errors >= 10) {
          console.log('[dev-sync] Too many errors, stopping batch');
          break;
        }
        await new Promise((r) => setTimeout(r, 3000));
      }
    }

    console.log(
      `[dev-sync] Done: ${updated} updated, ${errors} errors ` +
        `(${withoutData.length} sin-data + ${criticalRecheck.length} critical) [${lockKey}]`,
    );
    return {
      updated,
      errors,
      withoutData: withoutData.length,
      criticalRechecked: criticalRecheck.length,
    };
  } finally {
    global._devSyncLock[lockKey] = false;
  }
}

/**
 * Analiza órdenes en devolución desde el cache.
 * Usa servientrega_movements como fuente primaria.
 * Cuando está vacío, usa history (del getOrderDetail) como fallback.
 *
 * alertLevel:
 *   ok           = tiene "DEV CONFIRMADA POR BODEGA" en movements
 *   critical     = tiene "DEVOLUCION AL REMITENTE" sin escaneo (solo con movements)
 *   unverifiable = sin movements (managed_devolution_app=false), ya devuelta,
 *                  no podemos verificar escaneo en bodega
 *   pending      = aún no ha llegado la devolución final
 */
async function analyzeDevolutions(cacheWhere, from, until) {
  // ── Summary: SQL puro, sin parsear order_data ──
  const [summaryRows] = await db.query(
    `SELECT devolution_alert, COUNT(*) as cnt
     FROM dropi_orders_cache
     WHERE id_configuracion = :id_configuracion
       AND id_usuario = :id_usuario
       AND classified_status = 'devolucion'
       AND order_created_at BETWEEN :from AND :until
     GROUP BY devolution_alert`,
    {
      replacements: {
        id_configuracion: cacheWhere.id_configuracion ?? 0,
        id_usuario: cacheWhere.id_usuario ?? 0,
        from: `${from} 00:00:00`,
        until: `${until} 23:59:59`,
      },
    },
  );

  let withScan = 0,
    withoutScan = 0,
    pendingReturn = 0,
    unverifiable = 0;
  let totalDevolutions = 0;

  for (const r of summaryRows) {
    const cnt = Number(r.cnt || 0);
    totalDevolutions += cnt;
    if (r.devolution_alert === 'ok') withScan = cnt;
    else if (r.devolution_alert === 'critical') withoutScan = cnt;
    else if (r.devolution_alert === 'pending') pendingReturn = cnt;
    else unverifiable += cnt; // null + 'unverifiable'
  }

  // ── Detección de proveedor (ligera con JSON_EXTRACT) ──
  const [provRows] = await db.query(
    `SELECT
       COUNT(DISTINCT JSON_UNQUOTE(JSON_EXTRACT(order_data, '$.supplier.id'))) as suppliers,
       COUNT(DISTINCT JSON_UNQUOTE(JSON_EXTRACT(order_data, '$.user.id'))) as users
     FROM dropi_orders_cache
     WHERE id_configuracion = :id_configuracion
       AND id_usuario = :id_usuario
       AND classified_status = 'devolucion'
       AND order_created_at BETWEEN :from AND :until`,
    {
      replacements: {
        id_configuracion: cacheWhere.id_configuracion ?? 0,
        id_usuario: cacheWhere.id_usuario ?? 0,
        from: `${from} 00:00:00`,
        until: `${until} 23:59:59`,
      },
    },
  );

  const isSupplierView =
    provRows?.[0] &&
    Number(provRows[0].suppliers) === 1 &&
    Number(provRows[0].users) > 1;

  // ── Órdenes: todas, ordenadas por prioridad ──
  const devRows = await DropiOrdersCache.findAll({
    where: {
      ...cacheWhere,
      classified_status: 'devolucion',
      order_created_at: {
        [Op.between]: [`${from} 00:00:00`, `${until} 23:59:59`],
      },
    },
    attributes: [
      'dropi_order_id',
      'order_data',
      'total_order',
      'order_created_at',
      'dropshipper_profit',
      'devolution_alert',
    ],
    raw: true,
    order: [
      [
        literal(
          `FIELD(IFNULL(devolution_alert,'unverifiable'), 'critical', 'unverifiable', 'pending', 'ok')`,
        ),
      ],
      ['order_created_at', 'ASC'],
    ],
  });

  const orders = [];

  for (const row of devRows) {
    let od = {};
    try {
      od = JSON.parse(row.order_data || '{}');
    } catch (e) {
      continue;
    }

    const carrierMovements = (od.servientrega_movements || []).sort(
      (a, b) => new Date(a.created_at) - new Date(b.created_at),
    );
    const dropiHistory = (od.history || []).sort(
      (a, b) => new Date(a.created_at) - new Date(b.created_at),
    );
    const hasCarrierData = carrierMovements.length > 0;

    const details = od.orderdetails || [];
    const products = details.map((d) => ({
      name: d?.product?.name || 'Sin nombre',
      sku: d?.product?.sku || '',
      quantity: d?.quantity || 1,
      sale_price: d?.product?.sale_price || 0,
    }));

    // Timeline
    let timelineMovements;
    let timelineSource;

    if (hasCarrierData) {
      timelineSource = 'carrier';
      timelineMovements = carrierMovements.map((m) => ({
        nom_mov: m.nom_mov,
        created_at: m.created_at,
      }));
    } else if (dropiHistory.length > 0) {
      timelineSource = 'dropi_history';
      timelineMovements = dropiHistory
        .filter((h) => {
          const s = String(h.status || '').toUpperCase();
          return !(
            s === 'PENDIENTE CONFIRMACION' ||
            s === 'PENDIENTE' ||
            s === 'GUIA_GENERADA' ||
            s === 'PREPARADO PARA TRANSPORTADORA'
          );
        })
        .map((h) => ({
          nom_mov: h.status,
          created_at: h.created_at,
          novedad: h.novedad_servientrega || null,
        }));
    } else {
      timelineSource = 'none';
      timelineMovements = [];
    }

    const alertLevel = row.devolution_alert || 'unverifiable';

    orders.push({
      id: row.dropi_order_id,
      name: od.name || '',
      surname: od.surname || '',
      phone: od.phone || '',
      city: od.city || '',
      state: od.state || '',
      total_order: Number(row.total_order || 0),
      shipping_company: od.shipping_company || '',
      shipping_guide: od.shipping_guide || '',
      status: od.status || '',
      created_at: row.order_created_at,
      profit: row.dropshipper_profit,
      products,
      managedDevolution: od.managed_devolution_app === true,
      movements: timelineMovements,
      timelineSource,
      hasBodegaScan: alertLevel === 'ok',
      hasDevolucionRemitente: alertLevel === 'critical',
      alertLevel,
    });
  }

  return {
    isSupplierView,
    summary: {
      totalDevolutions,
      withScan,
      withoutScan,
      pendingReturn,
      unverifiable,
    },
    orders,
  };
}

/* ═══════════════════════════════════════════════════════════
   Computar stats desde cache
   ═══════════════════════════════════════════════════════════ */

async function computeStatsFromCache(cacheCtx, from, until) {
  const cacheWhere = buildCacheWhere(cacheCtx);

  const rows = await DropiOrdersCache.findAll({
    where: {
      ...cacheWhere,
      order_created_at: {
        [Op.between]: [`${from} 00:00:00`, `${until} 23:59:59`],
      },
    },
    attributes: [
      'dropi_order_id',
      'status',
      'classified_status',
      'total_order',
      'name',
      'surname',
      'city',
      'phone',
      'shipping_company',
      'shipping_guide',
      'product_names',
      'order_created_at',
      'dropshipper_profit',
    ],
    raw: true,
  });

  const statusStats = {};
  const dailyMap = {};
  const productMap = {};
  const retiroAgencia = [];
  const ordersByStatus = {};
  const now = new Date();

  let profitEntregadas = 0;
  let profitPotencialTotal = 0;
  let profitCalculated = 0;
  let profitPending = 0;

  for (const o of rows) {
    const cat = o.classified_status || 'otro';
    const total = Number(o.total_order || 0);
    const profit =
      o.dropshipper_profit !== null && o.dropshipper_profit !== undefined
        ? Number(o.dropshipper_profit)
        : null;

    if (!statusStats[cat]) statusStats[cat] = { count: 0, money: 0 };
    statusStats[cat].count += 1;
    statusStats[cat].money += total;

    if (profit !== null) {
      profitCalculated++;
      profitPotencialTotal += profit;
      if (cat === 'entregada') {
        profitEntregadas += profit;
      }
    } else {
      profitPending++;
    }

    const day = o.order_created_at
      ? new Date(o.order_created_at).toISOString().slice(0, 10)
      : null;
    if (day) {
      if (!dailyMap[day])
        dailyMap[day] = { day, pedidos: 0, entregadas: 0, devoluciones: 0 };
      dailyMap[day].pedidos += 1;
      if (cat === 'entregada') dailyMap[day].entregadas += 1;
      if (cat === 'devolucion') dailyMap[day].devoluciones += 1;
    }

    let productNames = [];
    try {
      productNames = JSON.parse(o.product_names || '[]');
    } catch (e) {}
    for (const name of productNames) {
      if (!productMap[name])
        productMap[name] = {
          name,
          ordenes: 0,
          entregadas: 0,
          devoluciones: 0,
          ingreso: 0,
        };
      productMap[name].ordenes += 1;
      if (cat === 'entregada') {
        productMap[name].entregadas += 1;
        productMap[name].ingreso += total;
      }
      if (cat === 'devolucion') productMap[name].devoluciones += 1;
    }

    // ── Orden individual para ordersByStatus (máx 25 por estado) ──
    const created = new Date(o.order_created_at);
    const diffDays = Math.floor((now - created) / (1000 * 60 * 60 * 24));

    const orderEntry = {
      id: o.dropi_order_id,
      name: o.name || '',
      surname: o.surname || '',
      phone: o.phone || '',
      city: o.city || '',
      shipping_company: o.shipping_company || '',
      shipping_guide: o.shipping_guide || '',
      total_order: total,
      status: o.status,
      created_at: o.order_created_at,
      days: diffDays,
      classified_status: cat,
      profit: profit,
    };

    if (!ordersByStatus[cat]) ordersByStatus[cat] = [];
    if (ordersByStatus[cat].length < 25) {
      ordersByStatus[cat].push(orderEntry);
    }

    // retiroAgencia legacy (compatibilidad)
    if (cat === 'retiro_agencia') {
      retiroAgencia.push(orderEntry);
    }
  }

  const totalOrders = rows.length;
  const entregadas = statusStats.entregada?.count || 0;
  const devoluciones = statusStats.devolucion?.count || 0;
  const totalMoney = rows.reduce((s, o) => s + Number(o.total_order || 0), 0);

  retiroAgencia.sort((a, b) => b.days - a.days);

  // Ordenar cada grupo en ordersByStatus por días desc
  for (const key of Object.keys(ordersByStatus)) {
    ordersByStatus[key].sort((a, b) => b.days - a.days);
  }

  const avgProfitPerOrder =
    profitCalculated > 0 ? profitPotencialTotal / profitCalculated : 0;

  // ── Análisis de devoluciones (escaneo bodega) ──
  const devolucionAnalysis = await analyzeDevolutions(cacheWhere, from, until);

  return {
    totalOrders,
    totalMoney,
    statusStats,
    ordersByStatus,
    kpis: {
      totalOrders,
      entregadas,
      devoluciones,
      canceladas: statusStats.cancelada?.count || 0,
      totalMoney,
      ingresoEntregadas: statusStats.entregada?.money || 0,
      tasaEntrega: totalOrders > 0 ? (entregadas / totalOrders) * 100 : 0,
      tasaDevolucion: totalOrders > 0 ? (devoluciones / totalOrders) * 100 : 0,
      ticketPromedio:
        entregadas > 0 ? (statusStats.entregada?.money || 0) / entregadas : 0,
      retiroAgencia: statusStats.retiro_agencia?.count || 0,
    },
    profitData: {
      profitEntregadas: Math.round(profitEntregadas * 100) / 100,
      profitPotencialTotal: Math.round(profitPotencialTotal * 100) / 100,
      profitCalculated,
      profitPending,
      totalOrders,
      entregadas,
      entregables:
        totalOrders -
        (statusStats.cancelada?.count || 0) -
        (statusStats.devolucion?.count || 0),
      avgProfitPerOrder: Math.round(avgProfitPerOrder * 100) / 100,
      isComplete: profitPending === 0,
      pctCalculated:
        totalOrders > 0
          ? Math.round((profitCalculated / totalOrders) * 100)
          : 0,
    },
    dailyChart: Object.values(dailyMap).sort((a, b) =>
      a.day.localeCompare(b.day),
    ),
    topProducts: Object.values(productMap)
      .sort((a, b) => b.ordenes - a.ordenes)
      .slice(0, 10),
    retiroAgencia: retiroAgencia.slice(0, 20),
    devolucionAnalysis,
  };
}

/* ═══════════════════════════════════════════════════════════
   getDashboardStats
   Soporta integration_id (user-level y config-level)
   o id_configuracion (legacy)
   ═══════════════════════════════════════════════════════════ */

exports.getDashboardStats = catchAsync(async (req, res, next) => {
  const integration_id = toInt(req.body?.integration_id);
  const id_configuracion = toInt(req.body?.id_configuracion);
  const id_usuario = req.sessionUser?.id_usuario;

  if (!integration_id && !id_configuracion) {
    return next(
      new AppError('integration_id o id_configuracion es requerido', 400),
    );
  }

  let integration;

  if (integration_id) {
    // ── Buscar por integration_id (soporta user-level y config-level) ──
    integration = await DropiIntegrations.findOne({
      where: { id: integration_id, deleted_at: null, is_active: 1 },
    });

    if (!integration) {
      return next(new AppError('Integración Dropi no encontrada', 404));
    }

    // Verificar ownership
    if (integration.id_configuracion) {
      const cfg = await Configuraciones.findOne({
        where: { id: integration.id_configuracion, id_usuario },
      });
      if (!cfg) {
        return next(
          new AppError('Integración no pertenece a esta cuenta', 403),
        );
      }
    } else {
      if (Number(integration.id_usuario) !== Number(id_usuario)) {
        return next(
          new AppError('Integración no pertenece a esta cuenta', 403),
        );
      }
    }
  } else {
    // ── Legacy: buscar por id_configuracion ──
    const cfg = await Configuraciones.findOne({
      where: { id: id_configuracion, id_usuario },
    });
    if (!cfg) {
      return next(
        new AppError(
          'Configuración no válida o no pertenece a esta cuenta',
          403,
        ),
      );
    }

    integration = await getActiveIntegration(id_configuracion);
    if (!integration) {
      return next(new AppError('No existe una integración Dropi activa', 404));
    }
  }

  const integrationKey = decryptToken(integration.integration_key_enc);
  if (!integrationKey) return next(new AppError('Dropi key inválida', 400));

  const from = strOrNull(req.body?.from);
  const until = strOrNull(req.body?.until);
  if (!from || !until)
    return next(new AppError('from y until son requeridos', 400));

  // Determinar cacheCtx según tipo de integración
  const cacheCtx = integration.id_configuracion
    ? { id_configuracion: Number(integration.id_configuracion) }
    : { id_usuario: Number(integration.id_usuario) };

  const cacheWhere = buildCacheWhere(cacheCtx);
  const lockKey = buildCacheKey(cacheCtx);
  const forceSync = req.body?.forceSync === true;

  // 1) ¿Cuántas órdenes hay en cache para este rango?
  const cachedCount = await DropiOrdersCache.count({
    where: {
      ...cacheWhere,
      order_created_at: {
        [Op.between]: [`${from} 00:00:00`, `${until} 23:59:59`],
      },
    },
  });

  console.log(
    `[dashboard] Cache has ${cachedCount} orders for ${lockKey} (${from} → ${until})`,
  );

  const syncKey = `${lockKey}_${from}_${until}`;

  // 2) Si no hay cache o forceSync → lanzar sync
  if (cachedCount === 0 || forceSync) {
    const prevSync = global._dropiSyncDone?.[syncKey];
    const syncRanRecently = prevSync && Date.now() - prevSync.at < 120000;

    if (cachedCount === 0 && syncRanRecently) {
      console.log(
        `[dashboard] Sync already ran for ${syncKey} (found ${prevSync.count} orders). Returning empty.`,
      );

      return res.json({
        isSuccess: true,
        data: {
          syncing: false,
          totalOrders: 0,
          totalMoney: 0,
          statusStats: {},
          kpis: {
            totalOrders: 0,
            entregadas: 0,
            devoluciones: 0,
            canceladas: 0,
            totalMoney: 0,
            ingresoEntregadas: 0,
            tasaEntrega: 0,
            tasaDevolucion: 0,
            ticketPromedio: 0,
            retiroAgencia: 0,
          },
          dailyChart: [],
          topProducts: [],
          retiroAgencia: [],
          pagesFetched: 0,
          isPartial: false,
          partialMessage: null,
          fromCache: false,
        },
      });
    }

    // Sync en background
    syncFromDropi({
      integrationKey,
      country_code: integration.country_code,
      cacheCtx,
      from,
      until,
    }).catch((err) =>
      console.error('[dashboard] Background sync error:', err?.message),
    );

    if (cachedCount === 0) {
      return res.json({
        isSuccess: true,
        data: {
          syncing: true,
          message:
            'Sincronizando órdenes por primera vez. Consulte de nuevo en unos segundos.',
          totalOrders: 0,
          totalMoney: 0,
          statusStats: {},
          kpis: {
            totalOrders: 0,
            entregadas: 0,
            devoluciones: 0,
            canceladas: 0,
            totalMoney: 0,
            ingresoEntregadas: 0,
            tasaEntrega: 0,
            tasaDevolucion: 0,
            ticketPromedio: 0,
            retiroAgencia: 0,
          },
          dailyChart: [],
          topProducts: [],
          retiroAgencia: [],
          pagesFetched: 0,
          isPartial: false,
          partialMessage: null,
          fromCache: false,
        },
      });
    }
  } else {
    // Hay cache → sync background
    syncFromDropi({
      integrationKey,
      country_code: integration.country_code,
      cacheCtx,
      from,
      until,
    }).catch((err) =>
      console.error('[dashboard] Background sync error:', err?.message),
    );
  }

  // 3) Computar stats desde BD
  const stats = await computeStatsFromCache(cacheCtx, from, until);

  // ¿El sync background o dev-sync sigue corriendo?
  const stillSyncing =
    !!global._dropiSyncLock[lockKey] || !!global._devSyncLock[lockKey];

  return res.json({
    isSuccess: true,
    data: {
      ...stats,
      syncing: stillSyncing,
      fromCache: true,
      pagesFetched: 0,
      isPartial: false,
      partialMessage: stillSyncing
        ? 'Seguimos sincronizando tus órdenes en segundo plano. Los datos se actualizarán automáticamente.'
        : null,
    },
  });
});

exports.getCustomerHistory = catchAsync(async (req, res, next) => {
  const id_configuracion = toInt(req.query?.id_configuracion);
  const phone = str(req.params?.phone).replace(/\D/g, '');

  if (!phone || phone.length < 7) {
    return next(new AppError('Teléfono inválido', 400));
  }

  if (!id_configuracion) {
    return next(new AppError('id_configuracion es requerido', 400));
  }

  const integration = await getActiveIntegration(id_configuracion);
  if (!integration) {
    return next(new AppError('No existe una integración Dropi activa', 404));
  }

  const integrationKey = decryptToken(integration.integration_key_enc);
  if (!integrationKey) return next(new AppError('Dropi key inválida', 400));

  // Normalizar teléfono y generar variaciones
  let normalized = phone;
  if (normalized.startsWith('593')) normalized = normalized.substring(3);
  if (normalized.startsWith('0')) normalized = normalized.substring(1);

  const variations = [
    ...new Set([phone, normalized, '0' + normalized, '593' + normalized]),
  ];

  const allOrders = new Map();

  for (const variant of variations) {
    try {
      const dropiResponse = await dropiService.listMyOrders({
        integrationKey,
        params: {
          filter_by: 'CELULAR',
          value_filter_by: variant,
          result_number: 50,
          filter_date_by: 'FECHA DE CREADO',
        },
        country_code: integration.country_code,
      });

      const objects = dropiResponse?.objects || [];
      for (const order of objects) {
        if (order?.id) allOrders.set(order.id, order);
      }
    } catch (err) {
      // Si una variación falla (429, etc.), seguimos con las demás
      console.warn(`[history] Error con variación ${variant}: ${err?.message}`);
    }

    // Rate limit protection
    await new Promise((r) => setTimeout(r, 1000));
  }

  const orders = Array.from(allOrders.values()).sort(
    (a, b) => new Date(b.created_at) - new Date(a.created_at),
  );

  // Stats
  const stats = {
    total_orders: orders.length,
    delivered: 0,
    canceled: 0,
    pending: 0,
    in_transit: 0,
    total_revenue: 0,
  };

  for (const o of orders) {
    const cat = classifyDropiStatus(o.status);
    if (cat === 'entregada') {
      stats.delivered++;
      stats.total_revenue += Number(o.total_order || 0);
    } else if (cat === 'cancelada' || cat === 'devolucion') {
      stats.canceled++;
    } else if (cat === 'pendiente') {
      stats.pending++;
    } else if (
      cat === 'en_transito' ||
      cat === 'novedad' ||
      cat === 'retiro_agencia'
    ) {
      stats.in_transit++;
    }
  }

  // Nivel de riesgo
  const deliveryRate =
    stats.total_orders > 0
      ? (stats.delivered / stats.total_orders) * 100
      : null;

  let risk_level = 'unknown';
  let risk_color = 'gray';

  if (stats.total_orders === 0) {
    risk_level = 'new';
    risk_color = 'gray';
  } else if (deliveryRate >= 70) {
    risk_level = 'low';
    risk_color = 'success';
  } else if (deliveryRate >= 40) {
    risk_level = 'medium';
    risk_color = 'warning';
  } else {
    risk_level = 'high';
    risk_color = 'danger';
  }

  return res.json({
    isSuccess: true,
    data: {
      stats,
      risk: {
        level: risk_level,
        color: risk_color,
        delivery_rate: deliveryRate,
      },
      orders: orders.slice(0, 20).map((o) => ({
        id: o.id,
        date: (o.created_at || '').substring(0, 10),
        status: o.status,
        total: Number(o.total_order || 0),
        city: o.city || '',
      })),
    },
  });
});

exports.getClientStats = catchAsync(async (req, res, next) => {
  const id_configuracion = toInt(req.body?.id_configuracion);
  const order_ids = req.body?.order_ids;

  if (!id_configuracion)
    return next(new AppError('id_configuracion requerido', 400));
  if (!Array.isArray(order_ids) || order_ids.length === 0) {
    return next(new AppError('order_ids requerido (array)', 400));
  }

  const integration = await getActiveIntegration(id_configuracion);
  if (!integration)
    return next(new AppError('No existe integración Dropi activa', 404));

  const integrationKey = decryptToken(integration.integration_key_enc);
  if (!integrationKey) return next(new AppError('Dropi key inválida', 400));

  const csResponse = await dropiService.getClientStats({
    integrationKey,
    orderIds: order_ids.map(Number),
    country_code: integration.country_code,
  });

  const csData = csResponse?.data || csResponse || {};

  // Tomar el que tenga más total_orders
  let bestStat = null;
  for (const key of Object.keys(csData)) {
    const stat = csData[key];
    if (
      !bestStat ||
      (stat?.client_total_orders || 0) > (bestStat?.client_total_orders || 0)
    ) {
      bestStat = stat;
    }
  }

  return res.json({
    isSuccess: true,
    data: bestStat
      ? {
          total_orders_all_stores: bestStat.client_total_orders || 0,
          total_returns_all_stores: bestStat.client_total_orders_returneds || 0,
          has_repeated_orders: (bestStat.ordenes_repetidas || []).length > 0,
          repeated_orders: bestStat.ordenes_repetidas || [],
        }
      : null,
  });
});

/* ═══════════════════════════════════════════════════════════
   Daily Metrics Dashboard
   Combina datos manuales (gasto, mensajes) + agregados de cache
   ═══════════════════════════════════════════════════════════ */

async function resolveCacheCtxFromIntegration(req) {
  const integration_id = toInt(req.body?.integration_id);
  const id_configuracion = toInt(req.body?.id_configuracion);
  const id_usuario = req.sessionUser?.id_usuario;

  if (!integration_id && !id_configuracion) {
    throw new AppError('integration_id o id_configuracion es requerido', 400);
  }

  let integration;

  if (integration_id) {
    integration = await DropiIntegrations.findOne({
      where: { id: integration_id, deleted_at: null, is_active: 1 },
    });
    if (!integration) throw new AppError('Integración no encontrada', 404);

    if (integration.id_configuracion) {
      const cfg = await Configuraciones.findOne({
        where: { id: integration.id_configuracion, id_usuario },
      });
      if (!cfg)
        throw new AppError('Integración no pertenece a esta cuenta', 403);
    } else if (Number(integration.id_usuario) !== Number(id_usuario)) {
      throw new AppError('Integración no pertenece a esta cuenta', 403);
    }
  } else {
    const cfg = await Configuraciones.findOne({
      where: { id: id_configuracion, id_usuario },
    });
    if (!cfg) throw new AppError('Configuración no válida', 403);
    integration = await getActiveIntegration(id_configuracion);
    if (!integration)
      throw new AppError('No hay integración Dropi activa', 404);
  }

  return integration.id_configuracion
    ? { id_configuracion: Number(integration.id_configuracion) }
    : { id_usuario: Number(integration.id_usuario) };
}

exports.getDailyMetrics = catchAsync(async (req, res, next) => {
  const cacheCtx = await resolveCacheCtxFromIntegration(req);
  const from = strOrNull(req.body?.from);
  const until = strOrNull(req.body?.until);

  if (!from || !until) {
    return next(new AppError('from y until son requeridos', 400));
  }

  const idCfg = cacheCtx.id_configuracion ?? 0;
  const idUsr = cacheCtx.id_usuario ?? 0;

  // Agregados desde cache, agrupados por fecha
  const [aggRows] = await db.query(
    `SELECT 
      DATE(c.order_created_at) AS fecha,
      COUNT(*) AS ordenes_dia,
      SUM(c.total_order) AS venta_total,
      SUM(CASE WHEN c.classified_status = 'entregada' THEN c.total_order ELSE 0 END) AS venta_entregadas,
      SUM(CASE WHEN c.classified_status = 'entregada' THEN COALESCE(c.dropshipper_profit, 0) ELSE 0 END) AS profit_entregadas,
      SUM(CASE WHEN c.classified_status != 'cancelada'
              THEN COALESCE(CAST(JSON_UNQUOTE(JSON_EXTRACT(c.order_data, '$.shipping_amount')) AS DECIMAL(10,2)), 0)
              ELSE 0 END) AS flete_total,
      SUM(CASE WHEN c.classified_status = 'entregada'
              THEN COALESCE(CAST(JSON_UNQUOTE(JSON_EXTRACT(c.order_data, '$.shipping_amount')) AS DECIMAL(10,2)), 0)
              ELSE 0 END) AS flete_entregadas,
      -- FIX 2026-04-30: flete_movilizadas = SOLO órdenes que físicamente se movieron del courier.
      -- Excluye 'pendiente' y 'guia_generada' (todavía en bodega) y 'cancelada'.
      -- Incluye: entregada, devolucion, en_transito, en_reparto, novedad, retiro_agencia.
      SUM(CASE WHEN c.classified_status IN ('entregada','devolucion','en_transito','en_reparto','novedad','retiro_agencia')
              THEN COALESCE(CAST(JSON_UNQUOTE(JSON_EXTRACT(c.order_data, '$.shipping_amount')) AS DECIMAL(10,2)), 0)
              ELSE 0 END) AS flete_movilizadas,
      SUM(CASE WHEN c.classified_status = 'entregada' THEN 1 ELSE 0 END) AS entregadas,
      SUM(CASE WHEN c.classified_status = 'cancelada' THEN 1 ELSE 0 END) AS cancelados,
      SUM(CASE WHEN c.classified_status = 'devolucion' THEN 1 ELSE 0 END) AS devoluciones,
      SUM(CASE WHEN c.classified_status IN ('en_transito','en_reparto','novedad','retiro_agencia','guia_generada','pendiente') THEN 1 ELSE 0 END) AS transito,
      -- FIX 2026-05-01: movilizadas = órdenes que el courier ya tomó (entregadas + devueltas + en transito real)
      -- Excluye canceladas (no salieron) y excluye pendiente/guia_generada (todavía en bodega)
      SUM(CASE WHEN c.classified_status IN ('entregada','devolucion','en_transito','en_reparto','novedad','retiro_agencia') THEN 1 ELSE 0 END) AS movilizadas
    FROM dropi_orders_cache c
    WHERE c.id_configuracion = :idCfg
      AND c.id_usuario = :idUsr
      AND c.order_created_at BETWEEN :from AND :until
    GROUP BY DATE(c.order_created_at)
    ORDER BY fecha DESC`,
    {
      replacements: {
        idCfg,
        idUsr,
        from: `${from} 00:00:00`,
        until: `${until} 23:59:59`,
      },
    },
  );

  // Manuales del rango
  const manuales = await DropiDailyMetrics.findAll({
    where: {
      id_configuracion: idCfg,
      id_usuario: idUsr,
      fecha: { [Op.between]: [from, until] },
    },
    raw: true,
  });

  const manualMap = new Map();
  for (const m of manuales) {
    const key =
      typeof m.fecha === 'string'
        ? m.fecha
        : m.fecha.toISOString().slice(0, 10);
    manualMap.set(key, m);
  }

  // FIX 2026-05-01 (v4): tasa de entrega histórica del rango y % margen,
  // para proyectar lo que VA a entregarse del tránsito actual.
  // Esto permite mostrar una columna "rentabilidad proyectada" más amable
  // en días donde el flete ya se gastó pero la venta aún no se cobró.
  let _totalEntregadas = 0;
  let _totalMovilizadas = 0;
  let _totalVentaEnt = 0;
  let _totalCostoEnt = 0;
  let _totalFleteEnt = 0;
  for (const r of aggRows) {
    const ve = Number(r.venta_entregadas || 0);
    const fe = Number(r.flete_entregadas || 0);
    const pe = Number(r.profit_entregadas || 0);
    const ce = Math.max(0, ve - fe - pe);
    _totalEntregadas += Number(r.entregadas || 0);
    _totalMovilizadas += Number(r.movilizadas || 0);
    _totalVentaEnt += ve;
    _totalCostoEnt += ce;
    _totalFleteEnt += fe;
  }
  // Tasa entrega = entregadas / movilizadas (NO sobre total — canceladas no penalizan)
  const tasaEntregaHist = _totalMovilizadas > 0 ? _totalEntregadas / _totalMovilizadas : 0.6; // default 60% si no hay data
  // Ticket promedio (venta entregadas / órdenes entregadas)
  const ticketPromedio = _totalEntregadas > 0 ? _totalVentaEnt / _totalEntregadas : 0;
  // % costo histórico = costo / venta (típico 30-50% en dropshipping)
  const pctCostoHist = _totalVentaEnt > 0 ? _totalCostoEnt / _totalVentaEnt : 0.5;
  // % flete histórico por entrega = flete_entregadas / venta_entregadas (típico 5-15%)
  const pctFleteHist = _totalVentaEnt > 0 ? _totalFleteEnt / _totalVentaEnt : 0.10;

  // Merge
  const fechasConOrdenes = new Set();
  const rows = aggRows.map((r) => {
    const fechaStr =
      typeof r.fecha === 'string'
        ? r.fecha
        : r.fecha.toISOString().slice(0, 10);
    fechasConOrdenes.add(fechaStr);

    const manual = manualMap.get(fechaStr) || {};
    const gasto = Number(manual.gasto_diario || 0);
    const mensajes = Number(manual.num_mensajes || 0);

    const ventaTotal = Number(r.venta_total || 0);
    const ventaEntregadas = Number(r.venta_entregadas || 0);
    const profitEntregadas = Number(r.profit_entregadas || 0);
    const fleteTotal = Number(r.flete_total || 0);
    const fleteEntregadas = Number(r.flete_entregadas || 0);
    const fleteMovilizadas = Number(r.flete_movilizadas || 0);
    const transitoOrdenes = Number(r.transito || 0);

    const costoProductoEntregadas = Math.max(
      0,
      ventaEntregadas - fleteEntregadas - profitEntregadas,
    );

    const costXMensaje = mensajes > 0 ? gasto / mensajes : 0;
    // Rentabilidad REAL (lo cobrado hoy)
    const rentabilidad =
      ventaEntregadas - costoProductoEntregadas - fleteMovilizadas - gasto;

    // ─────── PROYECCIÓN ───────
    // De las órdenes en tránsito, asumimos que se entregarán según tasa histórica.
    // Esa entrega futura genera venta extra que TODAVÍA no se contabiliza pero el flete ya se gastó.
    const ordenesProyectadasEntregar = transitoOrdenes * tasaEntregaHist;
    const ventaProyectadaExtra = ordenesProyectadasEntregar * ticketPromedio;
    const costoProyectadoExtra = ventaProyectadaExtra * pctCostoHist;
    // El flete ya está incluido en flete_movilizadas (cuenta tránsito), no lo sumamos otra vez
    const rentabilidadProyectadaExtra = ventaProyectadaExtra - costoProyectadoExtra;
    const rentabilidadProyectada = rentabilidad + rentabilidadProyectadaExtra;

    // Tasa entrega LOCAL del día (sobre movilizadas, no sobre total)
    const movDia = Number(r.movilizadas || 0);
    const tasaEntregaDia = movDia > 0 ? (Number(r.entregadas || 0) / movDia) : null;

    return {
      fecha: fechaStr,
      gasto_diario: Math.round(gasto * 100) / 100,
      num_mensajes: mensajes,
      cost_x_mensaje: Math.round(costXMensaje * 10000) / 10000,
      ordenes_dia: Number(r.ordenes_dia || 0),
      venta_total: Math.round(ventaTotal * 100) / 100,
      venta_entregadas: Math.round(ventaEntregadas * 100) / 100,
      costo_producto_entregadas:
        Math.round(costoProductoEntregadas * 100) / 100,
      flete_total: Math.round(fleteTotal * 100) / 100,
      flete_entregadas: Math.round(fleteEntregadas * 100) / 100,
      flete_movilizadas: Math.round(fleteMovilizadas * 100) / 100,
      cancelados: Number(r.cancelados || 0),
      devoluciones: Number(r.devoluciones || 0),
      entregados: Number(r.entregadas || 0),
      transito: transitoOrdenes,
      movilizadas: movDia,
      tasa_entrega_dia: tasaEntregaDia !== null ? Math.round(tasaEntregaDia * 1000) / 10 : null, // 0..100
      rentabilidad: Math.round(rentabilidad * 100) / 100,
      // Nuevos campos de proyección
      rentabilidad_proyectada: Math.round(rentabilidadProyectada * 100) / 100,
      venta_proyectada_extra: Math.round(ventaProyectadaExtra * 100) / 100,
      ordenes_proyectadas_extra: Math.round(ordenesProyectadasEntregar * 10) / 10,
      es_proyeccion: transitoOrdenes > 0, // si tiene tránsito, hay parte proyectada
    };
  });

  // Días con gasto manual pero sin órdenes ese día (también se muestran)
  for (const m of manuales) {
    const fechaStr =
      typeof m.fecha === 'string'
        ? m.fecha
        : m.fecha.toISOString().slice(0, 10);
    if (fechasConOrdenes.has(fechaStr)) continue;
    const gasto = Number(m.gasto_diario || 0);
    const mensajes = Number(m.num_mensajes || 0);
    if (gasto === 0 && mensajes === 0) continue;
    rows.push({
      fecha: fechaStr,
      gasto_diario: Math.round(gasto * 100) / 100,
      num_mensajes: mensajes,
      cost_x_mensaje:
        mensajes > 0 ? Math.round((gasto / mensajes) * 10000) / 10000 : 0,
      ordenes_dia: 0,
      venta_total: 0,
      venta_entregadas: 0,
      costo_producto_entregadas: 0,
      flete_total: 0,
      flete_entregadas: 0,
      flete_movilizadas: 0,
      cancelados: 0,
      devoluciones: 0,
      entregados: 0,
      transito: 0,
      movilizadas: 0,
      tasa_entrega_dia: null,
      rentabilidad: -gasto,
      rentabilidad_proyectada: -gasto,
      venta_proyectada_extra: 0,
      ordenes_proyectadas_extra: 0,
      es_proyeccion: false,
    });
  }

  rows.sort((a, b) => b.fecha.localeCompare(a.fecha));

  const totales = rows.reduce(
    (acc, r) => ({
      gasto_diario: acc.gasto_diario + r.gasto_diario,
      num_mensajes: acc.num_mensajes + r.num_mensajes,
      ordenes_dia: acc.ordenes_dia + r.ordenes_dia,
      venta_total: acc.venta_total + r.venta_total,
      venta_entregadas: acc.venta_entregadas + (r.venta_entregadas || 0),
      costo_producto_entregadas:
        acc.costo_producto_entregadas + r.costo_producto_entregadas,
      flete_total: acc.flete_total + r.flete_total,
      flete_entregadas: acc.flete_entregadas + (r.flete_entregadas || 0),
      flete_movilizadas: acc.flete_movilizadas + (r.flete_movilizadas || 0),
      cancelados: acc.cancelados + r.cancelados,
      devoluciones: acc.devoluciones + r.devoluciones,
      entregados: acc.entregados + r.entregados,
      transito: acc.transito + r.transito,
      movilizadas: acc.movilizadas + (r.movilizadas || 0),
      rentabilidad: acc.rentabilidad + r.rentabilidad,
      rentabilidad_proyectada: acc.rentabilidad_proyectada + (r.rentabilidad_proyectada || 0),
      venta_proyectada_extra: acc.venta_proyectada_extra + (r.venta_proyectada_extra || 0),
      ordenes_proyectadas_extra: acc.ordenes_proyectadas_extra + (r.ordenes_proyectadas_extra || 0),
    }),
    {
      gasto_diario: 0,
      num_mensajes: 0,
      ordenes_dia: 0,
      venta_total: 0,
      venta_entregadas: 0,
      costo_producto_entregadas: 0,
      flete_total: 0,
      flete_entregadas: 0,
      flete_movilizadas: 0,
      cancelados: 0,
      devoluciones: 0,
      entregados: 0,
      transito: 0,
      movilizadas: 0,
      rentabilidad: 0,
      rentabilidad_proyectada: 0,
      venta_proyectada_extra: 0,
      ordenes_proyectadas_extra: 0,
    },
  );
  // Tasa entrega global del rango (sobre movilizadas, no sobre total)
  totales.tasa_entrega = totales.movilizadas > 0
    ? Math.round((totales.entregados / totales.movilizadas) * 1000) / 10
    : null;
  // Meta info de la proyección para mostrar en frontend
  totales._proyeccion_meta = {
    tasa_entrega_historica: Math.round(tasaEntregaHist * 1000) / 10,
    ticket_promedio: Math.round(ticketPromedio * 100) / 100,
    pct_costo_historico: Math.round(pctCostoHist * 1000) / 10,
    pct_flete_historico: Math.round(pctFleteHist * 1000) / 10,
  };

  totales.cost_x_mensaje =
    totales.num_mensajes > 0 ? totales.gasto_diario / totales.num_mensajes : 0;

  // Redondear totales
  for (const k of Object.keys(totales)) {
    if (
      k === 'num_mensajes' ||
      k === 'ordenes_dia' ||
      k === 'cancelados' ||
      k === 'devoluciones' ||
      k === 'entregados' ||
      k === 'transito'
    )
      continue;
    totales[k] = Math.round(totales[k] * 100) / 100;
  }

  return res.json({ isSuccess: true, data: { rows, totales } });
});

exports.upsertDailyMetric = catchAsync(async (req, res, next) => {
  const cacheCtx = await resolveCacheCtxFromIntegration(req);
  const fecha = strOrNull(req.body?.fecha);
  const gasto_diario = req.body?.gasto_diario;
  const num_mensajes = req.body?.num_mensajes;

  if (!fecha) return next(new AppError('fecha es requerida (YYYY-MM-DD)', 400));

  const idCfg = cacheCtx.id_configuracion ?? 0;
  const idUsr = cacheCtx.id_usuario ?? 0;

  const [row] = await DropiDailyMetrics.findOrCreate({
    where: { id_configuracion: idCfg, id_usuario: idUsr, fecha },
    defaults: {
      id_configuracion: idCfg,
      id_usuario: idUsr,
      fecha,
      gasto_diario: 0,
      num_mensajes: 0,
    },
  });

  if (gasto_diario !== undefined) row.gasto_diario = Number(gasto_diario) || 0;
  if (num_mensajes !== undefined) row.num_mensajes = Number(num_mensajes) || 0;
  await row.save();

  return res.json({
    isSuccess: true,
    data: {
      fecha: row.fecha,
      gasto_diario: Number(row.gasto_diario),
      num_mensajes: Number(row.num_mensajes),
    },
  });
});


// ════════════════════════════════════════════════════════════════════
// FIX 2026-05-01 — Detalle por PRODUCTO de un día específico
// Permite expandir una fila del dashboard daily-metrics y ver el
// breakdown de qué productos se vendieron, cuántos entregados, etc.
// ════════════════════════════════════════════════════════════════════
exports.getDailyDetailByProduct = catchAsync(async (req, res, next) => {
  const cacheCtx = await resolveCacheCtxFromIntegration(req);
  const fecha = strOrNull(req.body?.fecha);

  if (!fecha) {
    return next(new AppError('fecha (YYYY-MM-DD) es requerida', 400));
  }

  const idCfg = cacheCtx.id_configuracion ?? 0;
  const idUsr = cacheCtx.id_usuario ?? 0;

  // FIX 2026-05-01 (v6): vista DROPSHIPPER correcta
  // Venta = total_order × porción del producto · Costo = qty × sale_price · Flete prorrateado
  const [rows] = await db.query(
    `WITH order_subtotals AS (
      SELECT
        c.id AS order_id,
        c.classified_status,
        c.total_order,
        COALESCE(CAST(JSON_UNQUOTE(JSON_EXTRACT(c.order_data, '$.shipping_amount')) AS DECIMAL(10,2)), 0) AS shipping_amount,
        (SELECT SUM(x.qty * x.sp) FROM JSON_TABLE(c.order_data, '$.orderdetails[*]' COLUMNS (
          qty INT PATH '$.quantity',
          sp DECIMAL(10,2) PATH '$.product.sale_price'
        )) AS x) AS subtotal_items
      FROM dropi_orders_cache c
      WHERE c.id_configuracion = :idCfg
        AND c.id_usuario = :idUsr
        AND DATE(c.order_created_at) = :fecha
    )
    SELECT
      jt.product_id,
      jt.product_name,
      jt.sku,
      COUNT(DISTINCT os.order_id) AS ordenes,
      SUM(jt.quantity) AS unidades_total,
      SUM(CASE WHEN os.classified_status = 'entregada' THEN jt.quantity ELSE 0 END) AS unidades_entregadas,
      SUM(CASE WHEN os.classified_status = 'entregada' THEN 1 ELSE 0 END) AS ordenes_entregadas,
      SUM(CASE WHEN os.classified_status = 'cancelada' THEN 1 ELSE 0 END) AS canceladas,
      SUM(CASE WHEN os.classified_status = 'devolucion' THEN 1 ELSE 0 END) AS devoluciones,
      SUM(CASE WHEN os.classified_status IN ('en_transito','en_reparto','novedad','retiro_agencia','guia_generada','pendiente') THEN 1 ELSE 0 END) AS transito,
      -- COSTO del producto (lo que el dropshipper paga al proveedor IMPORSHOP)
      SUM(CASE WHEN os.classified_status = 'entregada' THEN (jt.quantity * jt.sale_price) ELSE 0 END) AS costo_entregadas,
      -- VENTA del producto (porción del total_order según peso del item)
      SUM(CASE WHEN os.classified_status = 'entregada' AND os.subtotal_items > 0
              THEN os.total_order * ((jt.quantity * jt.sale_price) / os.subtotal_items)
              ELSE 0 END) AS venta_entregadas,
      -- FLETE prorrateado (paga el dropshipper)
      SUM(CASE WHEN os.classified_status IN ('entregada','devolucion','en_transito','en_reparto','novedad','retiro_agencia')
                AND os.subtotal_items > 0
              THEN os.shipping_amount * ((jt.quantity * jt.sale_price) / os.subtotal_items)
              ELSE 0 END) AS flete_movilizadas
    FROM order_subtotals os,
    JSON_TABLE(
      (SELECT order_data FROM dropi_orders_cache WHERE id = os.order_id),
      '$.orderdetails[*]' COLUMNS (
        product_id INT PATH '$.product.id',
        product_name VARCHAR(300) PATH '$.product.name',
        sku VARCHAR(100) PATH '$.product.sku',
        sale_price DECIMAL(10,2) PATH '$.product.sale_price',
        quantity INT PATH '$.quantity'
      )
    ) AS jt
    GROUP BY jt.product_id, jt.product_name, jt.sku
    ORDER BY ordenes DESC, unidades_entregadas DESC`,
    {
      replacements: { idCfg, idUsr, fecha },
    },
  );

  const productos = rows.map((r) => {
    const ventaEntregadas = Number(r.venta_entregadas || 0);
    const costoEntregadas = Number(r.costo_entregadas || 0);
    const fleteMovilizadas = Number(r.flete_movilizadas || 0);
    return {
      product_id: Number(r.product_id || 0),
      sku: r.sku || '',
      nombre: r.product_name || '(sin nombre)',
      ordenes: Number(r.ordenes || 0),
      unidades_total: Number(r.unidades_total || 0),
      unidades_entregadas: Number(r.unidades_entregadas || 0),
      ordenes_entregadas: Number(r.ordenes_entregadas || 0),
      canceladas: Number(r.canceladas || 0),
      devoluciones: Number(r.devoluciones || 0),
      transito: Number(r.transito || 0),
      venta_entregadas: Math.round(ventaEntregadas * 100) / 100,
      costo_entregadas: Math.round(costoEntregadas * 100) / 100,
      flete_movilizadas: Math.round(fleteMovilizadas * 100) / 100,
      margen_bruto: Math.round((ventaEntregadas - costoEntregadas - fleteMovilizadas) * 100) / 100,
    };
  });

  return res.json({
    isSuccess: true,
    data: {
      fecha,
      productos,
      total_productos: productos.length,
    },
  });
});


// ════════════════════════════════════════════════════════════════════
// FIX 2026-05-01 (v3) — Alertas de productos con problemas
// Identifica productos con: baja tasa entrega, alta devolución, sin movimiento
// ════════════════════════════════════════════════════════════════════
exports.getAlertasProductos = catchAsync(async (req, res, next) => {
  const cacheCtx = await resolveCacheCtxFromIntegration(req);
  const from = strOrNull(req.body?.from);
  const until = strOrNull(req.body?.until);
  const minOrdenes = Number(req.body?.min_ordenes) || 5;

  if (!from || !until) {
    return next(new AppError('from y until son requeridos', 400));
  }

  const idCfg = cacheCtx.id_configuracion ?? 0;
  const idUsr = cacheCtx.id_usuario ?? 0;

  const [rows] = await db.query(
    `SELECT
      jt.product_id,
      jt.product_name,
      jt.sku,
      COUNT(DISTINCT c.id) AS ordenes_total,
      SUM(CASE WHEN c.classified_status = 'entregada' THEN 1 ELSE 0 END) AS entregadas,
      SUM(CASE WHEN c.classified_status = 'devolucion' THEN 1 ELSE 0 END) AS devueltas,
      SUM(CASE WHEN c.classified_status = 'cancelada' THEN 1 ELSE 0 END) AS canceladas,
      SUM(CASE WHEN c.classified_status IN ('en_transito','en_reparto','novedad','retiro_agencia','guia_generada','pendiente') THEN 1 ELSE 0 END) AS transito,
      SUM(CASE WHEN c.classified_status IN ('entregada','devolucion','en_transito','en_reparto','novedad','retiro_agencia') THEN 1 ELSE 0 END) AS movilizadas,
      -- FIX 2026-05-01: tasa entrega sobre MOVILIZADAS (entregadas+devueltas+tránsito real). Canceladas no penalizan.
      ROUND(SUM(CASE WHEN c.classified_status = 'entregada' THEN 1 ELSE 0 END)
            / NULLIF(SUM(CASE WHEN c.classified_status IN ('entregada','devolucion','en_transito','en_reparto','novedad','retiro_agencia') THEN 1 ELSE 0 END), 0) * 100, 1) AS tasa_entrega,
      -- FIX 2026-05-01: tasa devolución sobre FINALIZADAS (entregadas + devueltas) — refleja % real del ciclo cerrado
      ROUND(SUM(CASE WHEN c.classified_status = 'devolucion' THEN 1 ELSE 0 END)
            / NULLIF(SUM(CASE WHEN c.classified_status IN ('entregada','devolucion') THEN 1 ELSE 0 END), 0) * 100, 1) AS tasa_devolucion,
      ROUND(SUM(CASE WHEN c.classified_status = 'cancelada' THEN 1 ELSE 0 END) / COUNT(DISTINCT c.id) * 100, 1) AS tasa_cancelacion,
      MAX(DATE(c.order_created_at)) AS ultima_orden,
      DATEDIFF(CURDATE(), MAX(DATE(c.order_created_at))) AS dias_sin_movimiento,
      SUM(CASE WHEN c.classified_status = 'entregada' THEN (jt.quantity * jt.sale_price) ELSE 0 END) AS venta_entregadas
    FROM dropi_orders_cache c,
    JSON_TABLE(c.order_data, '$.orderdetails[*]' COLUMNS (
      product_id INT PATH '$.product.id',
      product_name VARCHAR(300) PATH '$.product.name',
      sku VARCHAR(100) PATH '$.product.sku',
      sale_price DECIMAL(10,2) PATH '$.product.sale_price',
      quantity INT PATH '$.quantity'
    )) AS jt
    WHERE c.id_configuracion = :idCfg
      AND c.id_usuario = :idUsr
      AND c.order_created_at BETWEEN :from AND :until
    GROUP BY jt.product_id, jt.product_name, jt.sku
    HAVING ordenes_total >= :minOrd
    ORDER BY tasa_entrega ASC, ordenes_total DESC`,
    {
      replacements: {
        idCfg, idUsr, minOrd: minOrdenes,
        from: `${from} 00:00:00`,
        until: `${until} 23:59:59`,
      },
    },
  );

  const productos = rows.map((r) => {
    const tasaEnt = Number(r.tasa_entrega || 0);
    const tasaDev = Number(r.tasa_devolucion || 0);
    const dias = Number(r.dias_sin_movimiento || 0);
    const ordenes = Number(r.ordenes_total || 0);

    // Clasificación (suavizada — sobre MOVILIZADAS, no sobre total)
    let nivel = 'ok';
    let alertas = [];
    // Crítico: tasa entrega < 50% sobre movilizadas con masa crítica (12+ órdenes)
    if (tasaEnt < 50 && ordenes >= 12) {
      nivel = 'critico';
      alertas.push(`Tasa de entrega ${tasaEnt}% — por debajo del promedio del rango`);
    } else if (tasaEnt < 65 && ordenes >= 8) {
      nivel = 'alto';
      alertas.push(`Tasa de entrega ${tasaEnt}% — para revisar`);
    }
    // Alto: devoluciones > 25% (suavizado de 30 → 25)
    if (tasaDev > 35) {
      if (nivel === 'ok' || nivel === 'medio') nivel = 'alto';
      alertas.push(`Devoluciones ${tasaDev}% — investigar causa`);
    }
    // Medio: inactivo más de 21 días (suavizado de 14 → 21)
    if (dias > 21) {
      if (nivel === 'ok') nivel = 'medio';
      alertas.push(`Inactivo hace ${dias} días`);
    }

    return {
      product_id: Number(r.product_id || 0),
      sku: r.sku || '',
      nombre: r.product_name || '(sin nombre)',
      ordenes_total: ordenes,
      entregadas: Number(r.entregadas || 0),
      devueltas: Number(r.devueltas || 0),
      canceladas: Number(r.canceladas || 0),
      transito: Number(r.transito || 0),
      tasa_entrega: tasaEnt,
      tasa_devolucion: tasaDev,
      tasa_cancelacion: Number(r.tasa_cancelacion || 0),
      ultima_orden: r.ultima_orden ? r.ultima_orden.toString().slice(0, 10) : null,
      dias_sin_movimiento: dias,
      venta_entregadas: Math.round(Number(r.venta_entregadas || 0) * 100) / 100,
      nivel_alerta: nivel,
      alertas,
    };
  });

  // Buckets para el frontend
  const criticos = productos.filter((p) => p.nivel_alerta === 'critico');
  const altos = productos.filter((p) => p.nivel_alerta === 'alto');
  const medios = productos.filter((p) => p.nivel_alerta === 'medio');
  const ok = productos.filter((p) => p.nivel_alerta === 'ok');

  return res.json({
    isSuccess: true,
    data: {
      total_productos: productos.length,
      criticos: criticos.length,
      altos: altos.length,
      medios: medios.length,
      ok: ok.length,
      productos,
    },
  });
});


// ════════════════════════════════════════════════════════════════════
// FIX 2026-05-01 (v3) — Top ciudades con más devoluciones
// ════════════════════════════════════════════════════════════════════
exports.getCiudadesDevoluciones = catchAsync(async (req, res, next) => {
  const cacheCtx = await resolveCacheCtxFromIntegration(req);
  const from = strOrNull(req.body?.from);
  const until = strOrNull(req.body?.until);
  const minOrdenes = Number(req.body?.min_ordenes) || 5;
  const ordenarPor = (req.body?.ordenar_por || 'tasa_devolucion').toString();

  if (!from || !until) {
    return next(new AppError('from y until son requeridos', 400));
  }

  const idCfg = cacheCtx.id_configuracion ?? 0;
  const idUsr = cacheCtx.id_usuario ?? 0;

  let orderClause;
  if (ordenarPor === 'devueltas') orderClause = 'devueltas DESC, ordenes_total DESC';
  else if (ordenarPor === 'tasa_entrega_asc') orderClause = 'tasa_entrega ASC, ordenes_total DESC';
  else orderClause = 'tasa_devolucion DESC, devueltas DESC';

  const [rows] = await db.query(
    `SELECT
      UPPER(TRIM(c.city)) AS city,
      COUNT(*) AS ordenes_total,
      SUM(CASE WHEN c.classified_status = 'entregada' THEN 1 ELSE 0 END) AS entregadas,
      SUM(CASE WHEN c.classified_status = 'devolucion' THEN 1 ELSE 0 END) AS devueltas,
      SUM(CASE WHEN c.classified_status = 'cancelada' THEN 1 ELSE 0 END) AS canceladas,
      SUM(CASE WHEN c.classified_status IN ('en_transito','en_reparto','novedad','retiro_agencia','guia_generada','pendiente') THEN 1 ELSE 0 END) AS transito,
      SUM(CASE WHEN c.classified_status IN ('entregada','devolucion','en_transito','en_reparto','novedad','retiro_agencia') THEN 1 ELSE 0 END) AS movilizadas,
      -- FIX 2026-05-01: tasa entrega sobre movilizadas, tasa devolución sobre FINALIZADAS
      ROUND(SUM(CASE WHEN c.classified_status = 'entregada' THEN 1 ELSE 0 END)
            / NULLIF(SUM(CASE WHEN c.classified_status IN ('entregada','devolucion','en_transito','en_reparto','novedad','retiro_agencia') THEN 1 ELSE 0 END), 0) * 100, 1) AS tasa_entrega,
      ROUND(SUM(CASE WHEN c.classified_status = 'devolucion' THEN 1 ELSE 0 END)
            / NULLIF(SUM(CASE WHEN c.classified_status IN ('entregada','devolucion') THEN 1 ELSE 0 END), 0) * 100, 1) AS tasa_devolucion,
      ROUND(SUM(CASE WHEN c.classified_status = 'cancelada' THEN 1 ELSE 0 END) / COUNT(*) * 100, 1) AS tasa_cancelacion
    FROM dropi_orders_cache c
    WHERE c.id_configuracion = :idCfg
      AND c.id_usuario = :idUsr
      AND c.order_created_at BETWEEN :from AND :until
      AND c.city IS NOT NULL
      AND TRIM(c.city) != ''
    GROUP BY UPPER(TRIM(c.city))
    HAVING ordenes_total >= :minOrd
       AND movilizadas >= 3
    ORDER BY ${orderClause}
    LIMIT 30`,
    {
      replacements: {
        idCfg, idUsr, minOrd: minOrdenes,
        from: `${from} 00:00:00`,
        until: `${until} 23:59:59`,
      },
    },
  );

  const ciudades = rows.map((r) => ({
    city: r.city,
    ordenes_total: Number(r.ordenes_total || 0),
    entregadas: Number(r.entregadas || 0),
    devueltas: Number(r.devueltas || 0),
    canceladas: Number(r.canceladas || 0),
    transito: Number(r.transito || 0),
    movilizadas: Number(r.movilizadas || 0),
    tasa_entrega: Number(r.tasa_entrega || 0),
    tasa_devolucion: Number(r.tasa_devolucion || 0),
    tasa_cancelacion: Number(r.tasa_cancelacion || 0),
  }));

  return res.json({ isSuccess: true, data: { ciudades, total_ciudades: ciudades.length } });
});


// ════════════════════════════════════════════════════════════════════
// FIX 2026-05-01 (v5) — Rentabilidad por PRODUCTO del rango
// Usa el % costo histórico global (calculado del rango) para estimar
// el costo de producto cuando no tenemos costo unitario directo en Dropi.
// ════════════════════════════════════════════════════════════════════
exports.getProductosRentabilidad = catchAsync(async (req, res, next) => {
  const cacheCtx = await resolveCacheCtxFromIntegration(req);
  const from = strOrNull(req.body?.from);
  const until = strOrNull(req.body?.until);
  const minOrdenes = Number(req.body?.min_ordenes) || 1;

  if (!from || !until) {
    return next(new AppError('from y until son requeridos', 400));
  }

  const idCfg = cacheCtx.id_configuracion ?? 0;
  const idUsr = cacheCtx.id_usuario ?? 0;

  // FIX 2026-05-01 (v6): vista DROPSHIPPER correcta.
  // - Venta del producto = total_order × (porción del producto en la orden)
  //   donde porción = (qty × sale_price) / subtotal_orden
  // - Costo del producto = qty × sale_price (lo que el dropshipper paga al proveedor IMPORSHOP)
  // - Flete del producto = shipping × porción
  // - Rentabilidad = Venta − Costo − Flete (sin descontar ads, no se atribuyen a producto)

  const [rows] = await db.query(
    `WITH order_subtotals AS (
      SELECT
        c.id AS order_id,
        c.classified_status,
        c.total_order,
        c.order_created_at,
        COALESCE(CAST(JSON_UNQUOTE(JSON_EXTRACT(c.order_data, '$.shipping_amount')) AS DECIMAL(10,2)), 0) AS shipping_amount,
        (SELECT SUM(x.qty * x.sp) FROM JSON_TABLE(c.order_data, '$.orderdetails[*]' COLUMNS (
          qty INT PATH '$.quantity',
          sp DECIMAL(10,2) PATH '$.product.sale_price'
        )) AS x) AS subtotal_items
      FROM dropi_orders_cache c
      WHERE c.id_configuracion = :idCfg
        AND c.id_usuario = :idUsr
        AND c.order_created_at BETWEEN :from AND :until
    )
    SELECT
      jt.product_id,
      jt.product_name,
      jt.sku,
      COUNT(DISTINCT os.order_id) AS ordenes,
      SUM(jt.quantity) AS unidades_total,
      SUM(CASE WHEN os.classified_status = 'entregada' THEN jt.quantity ELSE 0 END) AS unidades_entregadas,
      SUM(CASE WHEN os.classified_status = 'entregada' THEN 1 ELSE 0 END) AS ordenes_entregadas,
      SUM(CASE WHEN os.classified_status = 'cancelada' THEN 1 ELSE 0 END) AS canceladas,
      SUM(CASE WHEN os.classified_status = 'devolucion' THEN 1 ELSE 0 END) AS devoluciones,
      SUM(CASE WHEN os.classified_status IN ('en_transito','en_reparto','novedad','retiro_agencia','guia_generada','pendiente') THEN 1 ELSE 0 END) AS transito,
      SUM(CASE WHEN os.classified_status IN ('entregada','devolucion','en_transito','en_reparto','novedad','retiro_agencia') THEN 1 ELSE 0 END) AS movilizadas,
      -- COSTO del producto (lo que el dropshipper paga a IMPORSHOP) — solo entregadas
      SUM(CASE WHEN os.classified_status = 'entregada' THEN (jt.quantity * jt.sale_price) ELSE 0 END) AS costo_entregadas,
      -- VENTA del producto (porción del total_order según peso del item) — solo entregadas
      SUM(CASE WHEN os.classified_status = 'entregada' AND os.subtotal_items > 0
              THEN os.total_order * ((jt.quantity * jt.sale_price) / os.subtotal_items)
              ELSE 0 END) AS venta_entregadas,
      -- FLETE prorrateado entre items según peso, solo de las movilizadas (paga el dropshipper)
      SUM(CASE WHEN os.classified_status IN ('entregada','devolucion','en_transito','en_reparto','novedad','retiro_agencia')
                AND os.subtotal_items > 0
              THEN os.shipping_amount * ((jt.quantity * jt.sale_price) / os.subtotal_items)
              ELSE 0 END) AS flete_movilizadas
    FROM order_subtotals os,
    JSON_TABLE(
      (SELECT order_data FROM dropi_orders_cache WHERE id = os.order_id),
      '$.orderdetails[*]' COLUMNS (
        product_id INT PATH '$.product.id',
        product_name VARCHAR(300) PATH '$.product.name',
        sku VARCHAR(100) PATH '$.product.sku',
        sale_price DECIMAL(10,2) PATH '$.product.sale_price',
        quantity INT PATH '$.quantity'
      )
    ) AS jt
    GROUP BY jt.product_id, jt.product_name, jt.sku
    HAVING ordenes >= :minOrd`,
    {
      replacements: { idCfg, idUsr, minOrd: minOrdenes,
        from: `${from} 00:00:00`, until: `${until} 23:59:59` },
    },
  );

  const productos = rows.map((r) => {
    const ventaEnt = Number(r.venta_entregadas || 0);   // Lo que el dropshipper cobró al cliente final
    const costoEnt = Number(r.costo_entregadas || 0);   // Lo que pagó a IMPORSHOP por el producto
    const fleteMov = Number(r.flete_movilizadas || 0);  // Lo que pagó al courier
    const ordenes = Number(r.ordenes || 0);
    const entregadas = Number(r.ordenes_entregadas || 0);
    const movilizadas = Number(r.movilizadas || 0);
    const rentabilidad = ventaEnt - costoEnt - fleteMov;
    const tasaEnt = movilizadas > 0 ? Math.round((entregadas / movilizadas) * 1000) / 10 : null;
    const ticketPromedio = entregadas > 0 ? ventaEnt / entregadas : 0;
    const margenPorcentaje = ventaEnt > 0 ? Math.round((rentabilidad / ventaEnt) * 1000) / 10 : null;
    return {
      product_id: Number(r.product_id || 0),
      sku: r.sku || '',
      nombre: r.product_name || '(sin nombre)',
      ordenes: ordenes,
      unidades_total: Number(r.unidades_total || 0),
      unidades_entregadas: Number(r.unidades_entregadas || 0),
      ordenes_entregadas: entregadas,
      canceladas: Number(r.canceladas || 0),
      devoluciones: Number(r.devoluciones || 0),
      transito: Number(r.transito || 0),
      movilizadas: movilizadas,
      tasa_entrega: tasaEnt,
      venta_entregadas: Math.round(ventaEnt * 100) / 100,
      costo_estimado: Math.round(costoEnt * 100) / 100, // mantengo el nombre por compat con frontend
      flete_movilizadas: Math.round(fleteMov * 100) / 100,
      rentabilidad: Math.round(rentabilidad * 100) / 100,
      ticket_promedio: Math.round(ticketPromedio * 100) / 100,
      margen_pct: margenPorcentaje,
    };
  });

  productos.sort((a, b) => b.rentabilidad - a.rentabilidad);

  const totalRent = productos.reduce((s, p) => s + p.rentabilidad, 0);
  const totalVenta = productos.reduce((s, p) => s + p.venta_entregadas, 0);
  const positivos = productos.filter(p => p.rentabilidad > 0).length;
  const negativos = productos.filter(p => p.rentabilidad < 0).length;

  return res.json({
    isSuccess: true,
    data: {
      productos,
      meta: {
        total_productos: productos.length,
        positivos,
        negativos,
        rentabilidad_total: Math.round(totalRent * 100) / 100,
        venta_total: Math.round(totalVenta * 100) / 100,
        margen_pct_global: totalVenta > 0 ? Math.round((totalRent / totalVenta) * 1000) / 10 : null,
      },
    },
  });
});


// ════════════════════════════════════════════════════════════════════
// 2026-05-02 — Ciudades + Transportadoras: tasa entrega por courier
// Devuelve por ciudad un ranking de couriers con recomendaciones
// ════════════════════════════════════════════════════════════════════
exports.getCiudadesTransportadoras = catchAsync(async (req, res, next) => {
  const cacheCtx = await resolveCacheCtxFromIntegration(req);
  const from = strOrNull(req.query?.from || req.body?.from);
  const until = strOrNull(req.query?.until || req.body?.until);
  const minOrdenes = Number(req.query?.min_ordenes || req.body?.min_ordenes) || 5;
  const minCourier = 5; // mínimo de órdenes por courier en una ciudad para opinar

  if (!from || !until) {
    return next(new AppError('from y until son requeridos', 400));
  }

  const idCfg = cacheCtx.id_configuracion ?? 0;
  const idUsr = cacheCtx.id_usuario ?? 0;

  // Paso 1: agrupar por (ciudad, courier)
  const [rows] = await db.query(
    `SELECT
      UPPER(TRIM(c.city))                                                               AS city,
      UPPER(TRIM(COALESCE(c.courier, 'SIN COURIER')))                                  AS courier,
      COUNT(*)                                                                           AS total_ordenes,
      SUM(CASE WHEN c.classified_status = 'entregada'  THEN 1 ELSE 0 END)              AS entregadas,
      SUM(CASE WHEN c.classified_status = 'devolucion' THEN 1 ELSE 0 END)              AS devoluciones,
      SUM(CASE WHEN c.classified_status = 'cancelada'  THEN 1 ELSE 0 END)              AS canceladas,
      SUM(CASE WHEN c.classified_status IN (
            'en_transito','en_reparto','novedad','retiro_agencia','guia_generada','pendiente'
          ) THEN 1 ELSE 0 END)                                                          AS en_transito,
      ROUND(AVG(c.total_order), 2)                                                      AS ticket_promedio,
      -- tasa entrega sobre finalizadas (entregadas + devoluciones)
      ROUND(
        SUM(CASE WHEN c.classified_status = 'entregada' THEN 1 ELSE 0 END)
        / NULLIF(
            SUM(CASE WHEN c.classified_status IN ('entregada','devolucion') THEN 1 ELSE 0 END)
          , 0) * 100
      , 1)                                                                               AS tasa_entrega_pct
    FROM dropi_orders_cache c
    WHERE c.id_configuracion = :idCfg
      AND c.id_usuario       = :idUsr
      AND c.order_created_at BETWEEN :from AND :until
      AND c.city IS NOT NULL AND TRIM(c.city) != ''
    GROUP BY UPPER(TRIM(c.city)), UPPER(TRIM(COALESCE(c.courier, 'SIN COURIER')))
    ORDER BY UPPER(TRIM(c.city)), total_ordenes DESC`,
    {
      replacements: {
        idCfg, idUsr,
        from:  `${from} 00:00:00`,
        until: `${until} 23:59:59`,
      },
    },
  );

  // Paso 2: agrupar en mapa por ciudad
  const mapaGlobal = {};
  for (const r of rows) {
    const city    = r.city;
    const courier = r.courier;
    if (!mapaGlobal[city]) {
      mapaGlobal[city] = {
        ciudad: city,
        total_ordenes: 0,
        entregadas: 0,
        devoluciones: 0,
        transportadoras: [],
      };
    }
    const t = {
      courier,
      ordenes:          Number(r.total_ordenes || 0),
      entregadas:       Number(r.entregadas    || 0),
      devoluciones:     Number(r.devoluciones  || 0),
      canceladas:       Number(r.canceladas    || 0),
      en_transito:      Number(r.en_transito   || 0),
      ticket_promedio:  Math.round(Number(r.ticket_promedio || 0) * 100) / 100,
      tasa_entrega_pct: Number(r.tasa_entrega_pct || 0),
    };
    mapaGlobal[city].total_ordenes += t.ordenes;
    mapaGlobal[city].entregadas    += t.entregadas;
    mapaGlobal[city].devoluciones  += t.devoluciones;
    mapaGlobal[city].transportadoras.push(t);
  }

  // Paso 3: filtrar ciudades con >= min_ordenes y calcular mejor/peor courier + recomendacion
  const ciudades = Object.values(mapaGlobal)
    .filter((c) => c.total_ordenes >= minOrdenes)
    .map((c) => {
      // Ordenar transportadoras por tasa entrega desc
      c.transportadoras.sort((a, b) => b.tasa_entrega_pct - a.tasa_entrega_pct);

      const conMasa = c.transportadoras.filter((t) => t.ordenes >= minCourier);

      const mejor = conMasa.length
        ? conMasa.reduce((best, t) => t.tasa_entrega_pct > best.tasa_entrega_pct ? t : best, conMasa[0])
        : null;

      const peor = conMasa.length
        ? conMasa.reduce((worst, t) => t.tasa_entrega_pct < worst.tasa_entrega_pct ? t : worst, conMasa[0])
        : null;

      // Recomendación legible
      let recomendacion = '';
      if (mejor && peor && mejor.courier !== peor.courier) {
        const diff = Math.round(mejor.tasa_entrega_pct - peor.tasa_entrega_pct);
        recomendacion =
          `Prefiere ${mejor.courier} (${mejor.tasa_entrega_pct}% entrega) sobre ${peor.courier}` +
          ` (${peor.tasa_entrega_pct}% entrega). Diferencia de ${diff} puntos porcentuales.`;
      } else if (mejor) {
        recomendacion = `${mejor.courier} es la única transportadora con datos suficientes (${mejor.tasa_entrega_pct}% entrega).`;
      } else {
        recomendacion = 'Insuficientes datos por courier para recomendar (mín 5 órdenes por courier).';
      }

      const finalizadas = c.entregadas + c.devoluciones;
      const tasa_ciudad = finalizadas > 0
        ? Math.round((c.entregadas / finalizadas) * 1000) / 10
        : null;

      return {
        ciudad:           c.ciudad,
        total_ordenes:    c.total_ordenes,
        entregadas:       c.entregadas,
        devoluciones:     c.devoluciones,
        tasa_ciudad_pct:  tasa_ciudad,
        mejor_courier:    mejor ? { courier: mejor.courier, tasa: mejor.tasa_entrega_pct } : null,
        peor_courier:     peor && peor.courier !== mejor?.courier ? { courier: peor.courier, tasa: peor.tasa_entrega_pct } : null,
        recomendacion,
        transportadoras:  c.transportadoras,
      };
    })
    .sort((a, b) => b.total_ordenes - a.total_ordenes);

  return res.json({
    isSuccess: true,
    data: {
      ciudades,
      total_ciudades: ciudades.length,
      min_ordenes:    minOrdenes,
    },
  });
});
