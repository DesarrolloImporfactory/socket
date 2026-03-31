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

  if (
    s === 'ENTREGADO' ||
    s.includes('ENTREGADA') ||
    s === 'REPORTADO ENTREGADO' ||
    s === 'ENTREGA DIGITALIZADA' ||
    s === 'CERTIFICACION DE PRUEBA DE ENTREGA'
  )
    return 'entregada';
  if (
    s.includes('DEVOLUCION') ||
    s.includes('DEVOLUCIÓN') ||
    s === 'DEVUELTO' ||
    s === 'CERTIFICACION DEVOLUCION AL REMITENTE' ||
    s === 'DESAPLICADO'
  )
    return 'devolucion';
  if (
    s === 'CANCELADO' ||
    s.includes('CANCELADA') ||
    s === 'ANULADA' ||
    s === 'RECHAZADO' ||
    s === 'GUIA_ANULADA'
  )
    return 'cancelada';
  if (s === 'PENDIENTE' || s === 'PENDIENTE CONFIRMACION') return 'pendiente';
  if (
    s.includes('RETIRO EN AGENCIA') ||
    s.includes('ENVÍO LISTO EN OFICINA') ||
    s === 'ENVIO LISTO EN OFICINA'
  )
    return 'retiro_agencia';
  if (
    s.includes('NOVEDAD') ||
    s.includes('SOLUCION') ||
    s === 'CON NOVEDAD' ||
    s === 'DESTINATARIO FALLECIDO' ||
    s.includes('DESTINATARIO RE-PROGRAMA') ||
    s.includes('DESTINATARIO SOLICITA') ||
    s.includes('FUERA DE COBERTURA') ||
    s.includes('OBSTRUCCIÓN EN LA VÍA') ||
    s.includes('PROBLEMAS DE ORDEN') ||
    s.includes('VISITA A DESTINATARIO') ||
    s.includes('ACCIDENTE EN CARRETERA') ||
    s.includes('EN ESPERA DE FIRMA')
  )
    return 'novedad';
  if (
    s.includes('INDEMNIZ') ||
    s.includes('SINIESTRO') ||
    s.includes('INCAUTADO') ||
    s.includes('HURTAD') ||
    s.includes('AVERÍA')
  )
    return 'indemnizada';
  if (
    s === 'GUIA_GENERADA' ||
    s.includes('TRÁNSITO') ||
    s.includes('TRANSITO') ||
    s.includes('EN RUTA') ||
    s.includes('EN CAMINO') ||
    s.includes('EN REPARTO') ||
    s.includes('BODEGA') ||
    s.includes('EMBARCANDO') ||
    s.includes('RECOLECT') ||
    s.includes('RECOGIDO') ||
    s.includes('ASIGNADO') ||
    s.includes('PICKING') ||
    s.includes('PACKING') ||
    s.includes('GENERADO') ||
    s.includes('GENERADA') ||
    s.includes('ZONA DE ENTREGA') ||
    s.includes('PREPARADO') ||
    s.includes('INVENTARIO') ||
    s.includes('INGRES') ||
    s.includes('RECIBIDO') ||
    s === 'POR RECOLECTAR' ||
    s === 'PROCESAMIENTO' ||
    s.includes('EN DISTRIBUCION')
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

/**
 * Analiza órdenes en devolución desde el cache.
 * Parsea order_data para extraer los movimientos de tracking
 * (c aplica a TODAS las transportadoras)
 * y detecta cuáles NO tienen "DEV CONFIRMADA POR BODEGA".
 */
async function analyzeDevolutions(cacheWhere, from, until) {
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
    ],
    raw: true,
    order: [['order_created_at', 'DESC']],
  });

  const supplierIds = new Set();
  const userIds = new Set();
  const orders = [];

  for (const row of devRows) {
    let od = {};
    try {
      od = JSON.parse(row.order_data || '{}');
    } catch (e) {
      continue;
    }

    // Tracking para detección de proveedor
    if (od.supplier?.id) supplierIds.add(od.supplier.id);
    if (od.user?.id) userIds.add(od.user.id);

    // Movimientos ordenados cronológicamente
    const movements = (od.servientrega_movements || []).sort(
      (a, b) => new Date(a.created_at) - new Date(b.created_at),
    );

    // Detección de escaneo
    const hasBodegaScan = movements.some((m) =>
      String(m.nom_mov || '')
        .toUpperCase()
        .includes('DEV CONFIRMADA POR BODEGA'),
    );

    const hasDevolucionRemitente = movements.some((m) => {
      const upper = String(m.nom_mov || '').toUpperCase();
      return (
        upper.includes('DEVOLUCION AL REMITENTE') ||
        upper.includes('DEVOLUCIÓN AL REMITENTE')
      );
    });

    const managedDevolution = od.managed_devolution_app === true;

    // Productos
    const details = od.orderdetails || [];
    const products = details.map((d) => ({
      name: d?.product?.name || 'Sin nombre',
      sku: d?.product?.sku || '',
      quantity: d?.quantity || 1,
      sale_price: d?.product?.sale_price || 0,
    }));

    // Nivel de alerta
    // critical = ya se devolvió al remitente PERO no se escaneó en bodega
    // pending  = aún no ha llegado la devolución final (en tránsito de vuelta)
    // ok       = escaneada correctamente
    let alertLevel = 'ok';
    if (hasDevolucionRemitente && !hasBodegaScan) {
      alertLevel = 'critical';
    } else if (!hasDevolucionRemitente && !hasBodegaScan) {
      alertLevel = 'pending';
    }

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
      managedDevolution,
      movements: movements.map((m) => ({
        nom_mov: m.nom_mov,
        created_at: m.created_at,
      })),
      hasBodegaScan,
      hasDevolucionRemitente,
      alertLevel,
    });
  }

  // ── Detección de proveedor ──
  // Si hay un solo supplier_id y múltiples user_id → el usuario es proveedor
  const isSupplierView = supplierIds.size === 1 && userIds.size > 1;

  const totalDevolutions = orders.length;
  const withScan = orders.filter((o) => o.alertLevel === 'ok').length;
  const withoutScan = orders.filter((o) => o.alertLevel === 'critical').length;
  const pendingReturn = orders.filter((o) => o.alertLevel === 'pending').length;

  return {
    isSupplierView,
    summary: {
      totalDevolutions,
      withScan,
      withoutScan,
      pendingReturn,
    },
    orders,
  };
}

/* ═══════════════════════════════════════════════════════════
   Computar stats desde cache
   ═══════════════════════════════════════════════════════════ */

/**
 * REEMPLAZAR computeStatsFromCache en dropi_integrations.controller.js
 *
 * Cambios vs versión anterior:
 * - Agrega ordersByStatus: objeto con arrays de órdenes por cada classified_status (máx 25 por estado)
 * - Incluye phone en cada orden
 * - retiroAgencia sigue existiendo por compatibilidad pero ahora también está en ordersByStatus.retiro_agencia
 */
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

  return res.json({
    isSuccess: true,
    data: {
      ...stats,
      syncing: false,
      fromCache: true,
      pagesFetched: 0,
      isPartial: false,
      partialMessage: null,
    },
  });
});
