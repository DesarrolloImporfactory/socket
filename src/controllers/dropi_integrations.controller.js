const catchAsync = require('../utils/catchAsync');
const AppError = require('../utils/appError');

const DropiIntegrations = require('../models/dropi_integrations.model');
const Configuraciones = require('../models/configuraciones.model');

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
      403
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

    supplier_id: toInt(body.supplier_id),
    shop_id: toInt(body.shop_id),
    warehouses_selected_id: toInt(body.warehouses_selected_id),

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
        ', '
      )}`,
      400
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

    supplier_id: required.supplier_id,
    shop_id: required.shop_id,
    warehouses_selected_id: required.warehouses_selected_id,

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

/* =========================
   CRUD Integrations
========================= */

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

/* =========================
   Dropi: Crear Orden
   POST /api/v1/dropi_integrations/orders/myorders
========================= */

exports.createOrderMyOrders = catchAsync(async (req, res, next) => {
  const id_configuracion = toInt(req.body?.id_configuracion);
  if (!id_configuracion) {
    return next(new AppError('id_configuracion es requerido', 400));
  }

  await assertConfigBelongsToOwner(req, id_configuracion);

  const integration = await getActiveIntegration(id_configuracion);
  if (!integration) {
    return next(
      new AppError(
        'No existe una integración Dropi activa para esta configuración',
        404
      )
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
  });

  return res.json({
    isSuccess: true,
    message: 'Orden enviada a Dropi correctamente',
    data: dropiResponse,
  });
});
