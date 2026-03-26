const catchAsync = require('../utils/catchAsync');
const AppError = require('../utils/appError');

const DropiIntegrations = require('../models/dropi_integrations.model');
const Configuraciones = require('../models/configuraciones.model');
const ClientesChatCenter = require('../models/clientes_chat_center.model');
const Sub_usuarios_chat_center = require('../models/sub_usuarios_chat_center.model');
const { Op } = require('sequelize');
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
 * (Mismos campos, nada extra)
 */
function buildDropiOrderPayload(body = {}) {
  // Requeridos mínimos para que Dropi acepte (según su experiencia con Postman)
  const required = {
    type: strOrNull(body.type),
    type_service: strOrNull(body.type_service),
    rate_type: strOrNull(body.rate_type),

    total_order: toInt(body.total_order),
    shipping_amount: toInt(body.shipping_amount),
    payment_method_id: toInt(body.payment_method_id),

    // supplier_id: toInt(body.supplier_id),
    // shop_id: toInt(body.shop_id),
    // warehouses_selected_id: toInt(body.warehouses_selected_id),

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

  // Validación mínima de products según su body funcional
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
      name: str(p?.name), // Dropi le aceptó string aquí
      type: str(p?.type),

      variation_id:
        p?.variation_id === null || p?.variation_id === undefined
          ? null
          : toInt(p.variation_id),

      variations: Array.isArray(p?.variations) ? p.variations : [],

      quantity,
      price,

      // En su body funcional vienen como string
      sale_price: p?.sale_price ?? null,
      suggested_price: p?.suggested_price ?? null,
    };
  });

  // Opcionales pero incluidos en su body funcional (y los respetamos tal cual)
  const distributionCompany =
    body.distributionCompany && typeof body.distributionCompany === 'object'
      ? {
          id: toInt(body.distributionCompany.id),
          name: str(body.distributionCompany.name),
        }
      : null;

  // Armado FINAL: solo lo que usted usa
  return {
    type: required.type,
    type_service: required.type_service,
    rate_type: required.rate_type,

    total_order: required.total_order,
    shipping_amount: required.shipping_amount,
    payment_method_id: required.payment_method_id,

    notes: body.notes ?? '',

    // supplier_id: required.supplier_id,
    // shop_id: required.shop_id,
    // warehouses_selected_id: required.warehouses_selected_id,

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

  // Validación mínima exigida x Dropi
  if (!result_number || !result_number) {
    throw new AppError(
      'Filter_date_by y result_number son obligatorios para consultar órdenes',
      400,
    );
  }

  // Esto será query params para Dropi GET
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
   POST /api/v1/dropi_integrations/orders/myorders
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

  // Construir payload final (sin id_configuracion)
  const raw = { ...req.body };
  delete raw.id_configuracion;

  let payload;
  try {
    payload = buildDropiOrderPayload(raw);
  } catch (e) {
    return next(e);
  }

  // Llamada a Dropi (sin Bearer, con header Dropi-Key)
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

  // guardamos varias llaves para soportar:
  // - Dropi (9 dígitos)
  // - celulares con prefijo país (593XXXXXXXXX)
  // - países con 10 dígitos
  if (d.length >= 9) keys.push(d.slice(-9));
  if (d.length >= 10) keys.push(d.slice(-10));

  // opcional: si usted maneja otros países con 11+ y quiere más tolerancia
  // if (d.length >= 11) keys.push(d.slice(-11));

  // unique
  return Array.from(new Set(keys));
}

// =========================
// Enriquecer órdenes (bulk, 1 query clientes + 1 query subusuarios)
// =========================
async function enrichOrdersWithChatAndAgent({ id_configuracion, objects }) {
  if (!Array.isArray(objects) || objects.length === 0) return objects;

  // 1) recolectar phones desde Dropi
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

  // 2) Buscar clientes_chat_center que coincidan con esos keys
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

  // 3) índice por llaves
  const clientByKey = new Map();
  for (const c of clientes) {
    const ks1 = phoneKeys(c?.celular_cliente);

    [...ks1].forEach((k) => {
      if (k && !clientByKey.has(k)) clientByKey.set(k, c);
    });
  }

  // 4) encargados únicos
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

  // 5) Enriquecer cada orden
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

  // params (sin id_configuracion)
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

  // GET hacia Dropi
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

  // ✅ Enriquecer aquí
  const objects = dropiResponse?.objects || dropiResponse?.data?.objects || [];
  const enrichedObjects = await enrichOrdersWithChatAndAgent({
    id_configuracion,
    objects,
  });

  // Truco n+1: si vino 1 extra, hay mas paginas para el front paginado de 10
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

  // payload recomendado por doc
  const payload = {
    pageSize: toInt(req.body?.pageSize) || 50,
    startData: toInt(req.body?.startData) ?? 0,
    no_count: req.body?.no_count === false ? false : true,
    order_by: strOrNull(req.body?.order_by) || 'id',
    order_type: strOrNull(req.body?.order_type) || 'asc',
    keywords: str(req.body?.keywords || ''),
  };

  // filtros opcionales (solo si vienen)
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
  const country_id = toInt(req.query?.country_id) ?? 1; // default 1 de momento

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
  const rate_type = strOrNull(req.body?.rate_type); // "CON RECAUDO" "SIN RECAUDO"

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

exports.getDashboardStats = catchAsync(async (req, res, next) => {
  const id_configuracion = toInt(req.body?.id_configuracion);
  if (!id_configuracion)
    return next(new AppError('id_configuracion es requerido', 400));

  const integration = await getActiveIntegration(id_configuracion);
  if (!integration)
    return next(new AppError('No existe una integración Dropi activa', 404));

  const integrationKey = decryptToken(integration.integration_key_enc);
  if (!integrationKey) return next(new AppError('Dropi key inválida', 400));

  const from = strOrNull(req.body?.from);
  const until = strOrNull(req.body?.until);
  if (!from || !until)
    return next(new AppError('from y until son requeridos', 400));

  let allOrders = [];
  let start = 0;
  let keepGoing = true;
  const PAGE_SIZE = 100;
  let pagesCount = 0;
  let currentDelay = 2500; // 2.5s base — más conservador
  let consecutiveRetries = 0;
  const MAX_RETRIES_PER_PAGE = 5;

  console.log(`[dashboard] Starting fetch: from=${from} until=${until}`);

  while (keepGoing) {
    try {
      console.log(
        `[dashboard] Fetching page ${pagesCount + 1} (start=${start}, delay=${currentDelay}ms, orders=${allOrders.length})`,
      );

      const dropiResponse = await dropiService.listMyOrders({
        integrationKey,
        params: {
          result_number: PAGE_SIZE,
          start,
          filter_date_by: 'FECHA DE CREADO',
          from,
          until,
        },
        country_code: integration.country_code,
      });

      const objects = dropiResponse?.objects || [];
      allOrders = allOrders.concat(objects);
      pagesCount++;
      consecutiveRetries = 0; // reset on success

      console.log(
        `[dashboard] Page ${pagesCount} OK: ${objects.length} orders (total: ${allOrders.length})`,
      );

      keepGoing = objects.length >= PAGE_SIZE;
      start += PAGE_SIZE;

      if (allOrders.length >= 5000) {
        console.log('[dashboard] Safety limit 5000 reached, stopping.');
        break;
      }

      // Delay entre páginas — reset a base después de éxito
      currentDelay = 2500;
      if (keepGoing) await new Promise((r) => setTimeout(r, currentDelay));
    } catch (err) {
      const status = err?.statusCode || err?.status || 500;

      if (status === 429) {
        consecutiveRetries++;

        if (consecutiveRetries >= MAX_RETRIES_PER_PAGE) {
          console.log(
            `[dashboard] Max retries (${MAX_RETRIES_PER_PAGE}) reached at start=${start}. Returning partial data.`,
          );
          keepGoing = false;
          break;
        }

        currentDelay = Math.min(currentDelay * 2, 15000); // max 15s
        console.log(
          `[dashboard] 429 Rate limited (retry ${consecutiveRetries}/${MAX_RETRIES_PER_PAGE}). Waiting ${currentDelay}ms...`,
        );
        await new Promise((r) => setTimeout(r, currentDelay));
        continue; // retry same page
      }

      console.error(`[dashboard] Error at start=${start}: ${err?.message}`);
      keepGoing = false;
    }
  }

  console.log(
    `[dashboard] Fetch complete: ${allOrders.length} orders in ${pagesCount} pages`,
  );

  function classify(status) {
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

  const statusStats = {};
  const dailyMap = {};
  const productMap = {};
  const retiroAgencia = [];
  const now = new Date();

  for (const o of allOrders) {
    const cat = classify(o.status);
    const total = Number(o.total_order || 0);

    if (!statusStats[cat]) statusStats[cat] = { count: 0, money: 0 };
    statusStats[cat].count += 1;
    statusStats[cat].money += total;

    const day = (o.created_at || '').slice(0, 10);
    if (day) {
      if (!dailyMap[day])
        dailyMap[day] = { day, pedidos: 0, entregadas: 0, devoluciones: 0 };
      dailyMap[day].pedidos += 1;
      if (cat === 'entregada') dailyMap[day].entregadas += 1;
      if (cat === 'devolucion') dailyMap[day].devoluciones += 1;
    }

    const details = Array.isArray(o.orderdetails) ? o.orderdetails : [];
    for (const d of details) {
      const name = d?.product?.name || 'Sin nombre';
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

    if (cat === 'retiro_agencia') {
      const created = new Date(o.created_at);
      const diffDays = Math.floor((now - created) / (1000 * 60 * 60 * 24));
      retiroAgencia.push({
        id: o.id,
        name: o.name || '',
        surname: o.surname || '',
        city: o.city || '',
        shipping_company: o.shipping_company || '',
        shipping_guide: o.shipping_guide || '',
        total_order: total,
        status: o.status,
        created_at: o.created_at,
        days: diffDays,
      });
    }
  }

  const totalOrders = allOrders.length;
  const entregadas = statusStats.entregada?.count || 0;
  const devoluciones = statusStats.devolucion?.count || 0;
  const totalMoney = allOrders.reduce(
    (s, o) => s + Number(o.total_order || 0),
    0,
  );

  retiroAgencia.sort((a, b) => b.days - a.days);

  return res.json({
    isSuccess: true,
    data: {
      totalOrders,
      totalMoney,
      statusStats,
      kpis: {
        totalOrders,
        entregadas,
        devoluciones,
        canceladas: statusStats.cancelada?.count || 0,
        totalMoney,
        ingresoEntregadas: statusStats.entregada?.money || 0,
        tasaEntrega: totalOrders > 0 ? (entregadas / totalOrders) * 100 : 0,
        tasaDevolucion:
          totalOrders > 0 ? (devoluciones / totalOrders) * 100 : 0,
        ticketPromedio:
          entregadas > 0 ? (statusStats.entregada?.money || 0) / entregadas : 0,
        retiroAgencia: statusStats.retiro_agencia?.count || 0,
      },
      dailyChart: Object.values(dailyMap).sort((a, b) =>
        a.day.localeCompare(b.day),
      ),
      topProducts: Object.values(productMap)
        .sort((a, b) => b.ordenes - a.ordenes)
        .slice(0, 10),
      retiroAgencia: retiroAgencia.slice(0, 20),
      pagesFetched: pagesCount,
    },
  });
});
