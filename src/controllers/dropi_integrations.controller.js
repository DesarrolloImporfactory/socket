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
const dropiOrdersService = require('../services/dropiOrders.service');
const DropiDailyMetrics = require('../models/dropi_daily_metrics.model');
const ProductosChatCenter = require('../models/productos_chat_center.model');
const { isValidPhone, toDropiLocal } = require('../utils/phoneFactor');
const { matchEnLista } = require('../services/dropiAutoOrder.service');

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
 * Descubre el dropi_user_id (cuenta Dropi dueña de la key) al registrar la
 * integración: pide UNA página de órdenes recientes y, si todas pertenecen
 * al mismo user_id, esa es la cuenta (dropshipper). Proveedores (varios
 * user_ids) o cuentas sin órdenes quedan NULL — el cron los aprende después
 * (aprenderDropiUserId) en cuanto tengan movimiento.
 *
 * Best-effort y fire-and-forget: si Dropi falla o hay 429, no afecta el
 * registro del cliente. El webhook usa esta columna para mapear eventos de
 * órdenes nuevas aún no cacheadas.
 */
async function descubrirDropiUserId(integrationId) {
  try {
    const row = await DropiIntegrations.findOne({
      where: { id: integrationId, deleted_at: null },
    });
    if (!row || row.dropi_user_id) return;

    const integrationKey = decryptToken(row.integration_key_enc);
    if (!integrationKey?.trim()) return;

    const fmt = (d) => d.toISOString().slice(0, 10);
    const resp = await dropiService.listMyOrders({
      integrationKey,
      params: {
        result_number: 50,
        start: 0,
        filter_date_by: 'FECHA DE CAMBIO DE ESTATUS',
        from: fmt(new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)),
        until: fmt(new Date()),
      },
      country_code: row.country_code,
    });

    const orders = resp?.objects || [];
    const uids = new Set(
      orders.map((o) => o?.user_id).filter((v) => Number(v) > 0),
    );
    if (uids.size === 1) {
      row.dropi_user_id = Number([...uids][0]);
      await row.save();
    }
  } catch (_) {
    // sin drama: el cron lo aprenderá en la próxima corrida
  }
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

// Cotiza transportadoras para una orden EXISTENTE (para elegir/cambiar la
// transportadora al confirmar una orden en PENDIENTE CONFIRMACION). Reusa los
// endpoints Dropi ya probados: getOrderDetail, department, trajectory/bycity,
// getOriginCityForCalculateShipping y cotizaEnvioTransportadoraV2.
const _buildDept = (d) =>
  d
    ? {
        id: d.id || d.department_id,
        country_id: d.country_id || 1,
        name: d.name || d.department || d.nombre,
        department_code: d.department_code || null,
      }
    : undefined;

exports.cotizarTransportadorasOrden = catchAsync(async (req, res, next) => {
  const id_configuracion = Number(req.body?.id_configuracion);
  const dropi_order_id = Number(req.body?.dropi_order_id);
  if (!id_configuracion || !dropi_order_id)
    return next(
      new AppError('id_configuracion y dropi_order_id requeridos', 400),
    );

  const integration = await getActiveIntegration(id_configuracion);
  if (!integration)
    return next(new AppError('Sin integración Dropi activa', 404));
  const integrationKey = decryptToken(integration.integration_key_enc);
  const country_code = integration.country_code;

  // 1. Orden desde Dropi (producto, cantidad, destino, monto)
  const ordResp = await dropiService.getOrderDetail({
    integrationKey,
    orderId: dropi_order_id,
    country_code,
  });
  const ord =
    ordResp?.objects || ordResp?.data?.objects || ordResp?.data || ordResp || {};
  const det = (ord.orderdetails || [])[0] || {};
  const productId = Number(det?.product?.id || det?.product_id) || null;
  const productType = det?.product?.type || 'SIMPLE';
  const quantity = Number(det?.quantity) || 1;
  const amount = Number(ord?.total_order) || 0;
  const stateName = ord?.state;
  const cityName = ord?.city;
  if (!productId || !stateName || !cityName)
    return next(
      new AppError('La orden no tiene producto o destino para cotizar', 422),
    );

  // 2. Destino → objeto ciudad completo + cod_dane
  const statesResp = await dropiService.listStates({
    integrationKey,
    country_id: 1,
    country_code,
  });
  const states =
    statesResp?.objects || statesResp?.data?.objects || statesResp?.data || [];
  const state = matchEnLista(
    states,
    stateName,
    (x) => x.name || x.department || x.nombre,
  );
  if (!state)
    return next(new AppError(`No se resolvió la provincia "${stateName}"`, 422));

  const citiesResp = await dropiService.listCities({
    integrationKey,
    payload: { department_id: Number(state.id), rate_type: 'CON RECAUDO' },
    country_code,
  });
  const cities =
    citiesResp?.objects?.cities ||
    citiesResp?.data?.objects?.cities ||
    citiesResp?.cities ||
    citiesResp?.data?.cities ||
    [];
  const city = matchEnLista(cities, cityName, (x) => x.name || x.city || x.nombre);
  if (!city)
    return next(new AppError(`No se resolvió la ciudad "${cityName}"`, 422));
  const destCodDane = String(city.cod_dane || city.codDane || city.code_dane || '');
  const ciudad_destino = { ...city, department: city.department || _buildDept(state) };

  // 3. Remitente (origen) → getOriginCityForShipping por el producto
  let ciudad_remitente = null;
  try {
    const origResp = await dropiService.getOriginCityForShipping({
      integrationKey,
      productId,
      productType,
      destination: destCodDane,
      country_code,
    });
    const oc =
      origResp?.objects || origResp?.data?.objects || origResp?.data || origResp;
    if (oc && (oc.cod_dane || oc.id)) {
      ciudad_remitente = oc.department
        ? oc
        : {
            ...oc,
            department: _buildDept(
              states.find(
                (s) =>
                  Number(s.id || s.department_id) === Number(oc.department_id),
              ),
            ),
          };
    }
  } catch (_) {}
  if (!ciudad_remitente) ciudad_remitente = { ...ciudad_destino };

  // 4. Cotizar transportadoras
  const quoteResp = await dropiService.cotizaEnvioTransportadora({
    integrationKey,
    payload: {
      EnvioConCobro: true,
      ciudad_destino,
      ciudad_remitente,
      products: [{ id: productId, quantity, type: productType }],
      amount,
    },
    country_code,
  });
  const quotes = quoteResp?.objects || quoteResp?.data?.objects || [];
  const transportadoras = (Array.isArray(quotes) ? quotes : [])
    .map((q) => ({
      id:
        Number(
          q?.distributionCompany?.id ??
            q?.transportadora_id ??
            q?.distribution_company_id ??
            0,
        ) || null,
      name: String(
        q?.distributionCompany?.name ??
          q?.transportadora ??
          q?.distribution_company?.name ??
          q?.name ??
          '',
      ).trim(),
      price: Number(q?.objects?.precioEnvio ?? q?.precioEnvio ?? 0) || 0,
      // slug para la imagen: app.dropi.ec/assets/images/delivery/{slug}.png
      slug: String(
        q?.transportadora_minuscula ||
          q?.distributionCompany?.name ||
          q?.transportadora ||
          '',
      )
        .toLowerCase()
        .trim(),
    }))
    .filter((t) => t.id && t.name)
    .sort((a, b) => a.price - b.price);

  return res.json({
    ok: true,
    data: { transportadoras, actual: ord?.distributionCompany || null },
  });
});

// Cambia la transportadora de una orden existente replicando el flujo REAL de
// Dropi: NO edita la orden (Dropi ignora distributionCompany en el update).
// Crea una orden NUEVA (is_edit_order + id_old_order + la transportadora nueva)
// y marca la vieja como REEMPLAZADA. Devuelve la orden nueva.
exports.reemplazarOrdenTransportadora = catchAsync(async (req, res, next) => {
  const id_configuracion = Number(req.body?.id_configuracion);
  const dropi_order_id = Number(req.body?.dropi_order_id);
  const dc = req.body?.distributionCompany || {};
  const nuevoStatus = String(req.body?.status || 'PENDIENTE CONFIRMACION')
    .trim()
    .toUpperCase();
  // Datos editados opcionales (si el agente cambió nombre/dir/etc.)
  const edit = req.body?.edit || {};

  if (!id_configuracion || !dropi_order_id || !Number(dc.id))
    return next(
      new AppError(
        'id_configuracion, dropi_order_id y distributionCompany.id requeridos',
        400,
      ),
    );

  const integration = await getActiveIntegration(id_configuracion);
  if (!integration)
    return next(new AppError('Sin integración Dropi activa', 404));
  const integrationKey = decryptToken(integration.integration_key_enc);
  const country_code = integration.country_code;

  // 1. Orden actual desde Dropi
  const ordResp = await dropiService.getOrderDetail({
    integrationKey,
    orderId: dropi_order_id,
    country_code,
  });
  const o =
    ordResp?.objects || ordResp?.data?.objects || ordResp?.data || ordResp || {};

  const products = (o.orderdetails || []).map((d) => ({
    id: d?.product?.id || d?.product_id,
    name: d?.product?.name || d?.integration_product_name || 'Producto',
    weight: d?.product?.weight || '1.00',
    stock: d?.product?.warehouse_product?.[0]?.stock ?? undefined,
    variation_id: d?.variation_id || null,
    variations: [],
    quantity: Number(d?.quantity) || 1,
    price: Number(d?.price) || 0,
    sale_price: d?.product?.sale_price ?? null,
    suggested_price: d?.product?.suggested_price ?? null,
  }));
  if (!products.length)
    return next(new AppError('La orden no tiene productos', 422));

  const warehousesSelectedId =
    o?.warehouse_id || o?.warehouse?.id || products[0]?.warehouse_id || null;

  // 2. Payload de la orden NUEVA (reemplazo), calcado del flujo manual de Dropi
  const payload = {
    total_order: Number(o.total_order) || 0,
    notes: o.notes || '',
    name: (edit.name ?? o.name) || 'Cliente',
    surname: (edit.surname ?? o.surname) || '',
    country: o.country || 'ECUADOR',
    state: o.state,
    city: o.city,
    dir: (edit.dir ?? o.dir) || '',
    phone: (edit.phone ?? o.phone) || '',
    client_email: o.client_email || '',
    colonia: o.colonia || '',
    zip_code: o.zip_code || '',
    dni: o.dni || '',
    dni_type: o.dni_type || '',
    payment_method_id: o.payment_method_id || 1,
    rate_type: o.rate_type || 'CON RECAUDO',
    type: 'FINAL_ORDER',
    type_service: o.type_service || 'normal',
    insurance: false,
    status: nuevoStatus,
    distributionCompany: { id: Number(dc.id), name: dc.name || '' },
    warehouses_selected_id: warehousesSelectedId,
    is_edit_order: true,
    id_old_order: dropi_order_id,
    reasonComment: `Esta orden reemplaza a la orden ${dropi_order_id} que fue editada por el usuario.`,
    products,
  };

  // 3. Crear la orden nueva
  const created = await dropiService.createOrderMyOrders({
    integrationKey,
    payload,
    country_code,
  });
  const nueva = created?.objects || created?.data?.objects || created;
  const nuevoId = Number(nueva?.id) || null;

  // 4. Marcar la vieja como REEMPLAZADA (mismo criterio de Dropi)
  try {
    await dropiService.updateMyOrder({
      integrationKey,
      orderId: dropi_order_id,
      payload: {
        status: 'REEMPLAZADA',
        reasonComment: 'Cancelación por edición de orden',
        replaced: true,
      },
      country_code,
    });
  } catch (_) {}

  // 5a. La vieja pasa a REEMPLAZADA en el cache (se filtra del listado).
  try {
    await db.query(
      `UPDATE dropi_orders_cache SET status = 'REEMPLAZADA', updated_at = NOW()
        WHERE id_configuracion = ? AND dropi_order_id = ?`,
      { replacements: [id_configuracion, dropi_order_id] },
    );
  } catch (_) {}

  // 5b. Insertar YA la orden nueva al cache (no esperar al cron): el panel lee
  //     del cache, así muestra en tiempo real la orden vigente con su
  //     transportadora y status reales. Base = detalle viejo + overrides.
  try {
    if (nuevoId) {
      const ordenNueva = {
        ...o,
        ...(nueva && typeof nueva === 'object' ? nueva : {}),
        id: nuevoId,
        status: nuevoStatus,
        distributionCompany: { id: Number(dc.id), name: dc.name || '' },
        shipping_company: dc.name || o.shipping_company || null,
        shipping_guide: null, // orden nueva aún sin guía
        name: (edit.name ?? o.name) || o.name,
        surname: edit.surname ?? o.surname,
        phone: (edit.phone ?? o.phone) || o.phone,
        dir: edit.dir ?? o.dir,
        orderdetails: o.orderdetails || nueva?.orderdetails || [],
      };
      await upsertOrdersToCache({ id_configuracion }, [ordenNueva]);
    }
  } catch (e) {
    console.error('[reemplazar] upsert cache orden nueva falló:', e?.message);
  }

  return res.json({
    ok: true,
    data: { nuevo_dropi_order_id: nuevoId, status: nuevoStatus, order: nueva },
  });
});

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

  // Descubrir la cuenta Dropi dueña de la key (async, no bloquea la respuesta)
  setImmediate(() => descubrirDropiUserId(created.id));

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

  let tokenCambiado = false;
  if (token !== undefined && String(token).trim()) {
    row.integration_key_enc = encryptToken(token);
    row.integration_key_last4 = last4(token);
    // La nueva key puede ser de OTRA cuenta Dropi: invalidar y redescubrir
    row.dropi_user_id = null;
    tokenCambiado = true;
  }

  if (is_active !== undefined) row.is_active = is_active ? 1 : 0;

  await row.save();

  if (tokenCambiado) setImmediate(() => descubrirDropiUserId(row.id));

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

  // Descubrir la cuenta Dropi dueña de la key (async, no bloquea la respuesta)
  setImmediate(() => descubrirDropiUserId(nueva.id));

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

  const raw = { ...req.body };
  delete raw.id_configuracion;

  const data = await dropiOrdersService.createOrderForClient({
    id_configuracion,
    body: raw,
  });

  return res.json({
    isSuccess: true,
    message: 'Orden enviada a Dropi correctamente',
    data,
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

/* Mapa teléfono→id_cliente del chat en UNA consulta: compara por los
   últimos 9 dígitos (la misma semántica efectiva de phoneKeys: el
   sufijo de 9 decide el match) en vez de cientos de LIKE '%...' en OR,
   que obligaban a evaluar N patrones por cada fila de la config
   (~1.4s vs ~0.1s medido en prod). Además tolera teléfonos guardados
   con formato (+593 99...), que el LIKE crudo no matcheaba. */
async function fetchClientPhoneMap(id_configuracion, keys) {
  const keys9 = [...new Set([...keys].filter((k) => k.length === 9))];
  const map = new Map();
  if (!keys9.length) return map;
  const [rows] = await db.query(
    `SELECT id, celular_cliente FROM clientes_chat_center
      WHERE id_configuracion = :idCfg AND deleted_at IS NULL
        AND RIGHT(REGEXP_REPLACE(celular_cliente,'[^0-9]',''),9) IN (:keys)
      ORDER BY id`,
    { replacements: { idCfg: id_configuracion, keys: keys9 } },
  );
  for (const c of rows) {
    for (const k of phoneKeys(c.celular_cliente)) {
      if (!map.has(k)) map.set(k, c.id);
    }
  }
  return map;
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

  const integrationKey = getIntegrationKey(integration);

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

/* ═══════════════════════════════════════════════════════════
   listOrdersFromCache
   Vista Pedidos: lee dropi_orders_cache (NO golpea la API de
   Dropi en cada búsqueda/página). Enriquece con chat/agente,
   imagen del catálogo (productos_chat_center.id_dropi), estado
   del pedido (confirmado vs pendiente confirmación + bot) y
   origen (shop_type). Si el cache está viejo dispara un sync
   en background (con los locks y el skip de 10 min existentes).
   ═══════════════════════════════════════════════════════════ */

exports.listOrdersFromCache = catchAsync(async (req, res, next) => {
  const id_configuracion = toInt(req.body?.id_configuracion);
  if (!id_configuracion)
    return next(new AppError('id_configuracion es requerido', 400));

  const page = Math.max(1, toInt(req.body?.page) || 1);
  const pageSize = Math.min(100, Math.max(1, toInt(req.body?.page_size) || 10));

  const integration = await getActiveIntegration(id_configuracion);
  if (!integration) {
    // Sin plataforma de pedidos conectada: NO es un error — el front
    // muestra la vista con CTA para vincular alguna plataforma.
    return res.json({
      isSuccess: true,
      data: {
        rows: [],
        total: 0,
        page: 1,
        page_size: pageSize,
        total_pages: 1,
        sync: null,
        sin_integracion: true,
      },
    });
  }
  const from = strOrNull(req.body?.from);
  const until = strOrNull(req.body?.until);
  const status = strOrNull(req.body?.status);
  const origen = strOrNull(req.body?.origen); // imporsuit | shopify | otros
  const texto = strOrNull(req.body?.textToSearch);
  const forceSync = req.body?.force_sync === true;

  const cacheCtx = integration.id_configuracion
    ? { id_configuracion: Number(integration.id_configuracion) }
    : { id_usuario: Number(integration.id_usuario) };
  const cacheWhere = buildCacheWhere(cacheCtx);

  const where = { ...cacheWhere };
  if (from && until) {
    where.order_created_at = {
      [Op.between]: [`${from} 00:00:00`, `${until} 23:59:59`],
    };
  }
  if (status) where.status = status;
  else where.status = { [Op.ne]: 'REEMPLAZADA' };
  // ↑ Por defecto NO mostramos las REEMPLAZADA: son la versión vieja de una
  //   orden que Dropi clonó al editarla/generar guía y duplican la vista
  //   (confunden al cliente). Siguen accesibles filtrando por ese estado.
  // Filtro de origen consistente con el badge: el shop_type crudo de Dropi no
  // es confiable, así que resolvemos qué órdenes del cache matchean una orden
  // real del webhook Shopify (teléfono + total + ventana) y filtramos por id.
  if (origen === 'imporsuit' || origen === 'shopify' || origen === 'otros') {
    let shopifyIds = [];
    try {
      const matched = await db.query(
        `SELECT DISTINCT oc.dropi_order_id
           FROM dropi_orders_cache oc
           JOIN shopify_ordenes_webhook sow
             ON sow.id_configuracion = oc.id_configuracion
            AND sow.phone_normalizado IS NOT NULL
            AND RIGHT(REGEXP_REPLACE(oc.phone,'[^0-9]',''),9)
                = RIGHT(sow.phone_normalizado COLLATE utf8mb4_unicode_ci, 9)
            AND ABS(oc.total_order - sow.total_price) < 0.5
            AND oc.order_created_at BETWEEN
                  DATE_SUB(sow.shopify_created_at, INTERVAL 3 DAY)
              AND DATE_ADD(sow.shopify_created_at, INTERVAL 3 DAY)
          WHERE oc.id_configuracion = :idCfg AND oc.id_usuario = 0`,
        { replacements: { idCfg: id_configuracion }, type: db.QueryTypes.SELECT },
      );
      shopifyIds = matched.map((m) => Number(m.dropi_order_id)).filter(Boolean);
    } catch (_) {
      shopifyIds = [];
    }

    if (origen === 'shopify') {
      where.dropi_order_id = { [Op.in]: shopifyIds.length ? shopifyIds : [-1] };
    } else if (origen === 'imporsuit') {
      where.shop_type = 'IMPORSUIT';
      if (shopifyIds.length) where.dropi_order_id = { [Op.notIn]: shopifyIds };
    } else {
      // otros: ni Shopify (por webhook) ni IMPORSUIT
      where.shop_type = {
        [Op.or]: [{ [Op.is]: null }, { [Op.notIn]: ['IMPORSUIT', 'SHOPIFY'] }],
      };
      if (shopifyIds.length) where.dropi_order_id = { [Op.notIn]: shopifyIds };
    }
  }
  if (texto) {
    const like = { [Op.like]: `%${texto}%` };
    const orText = [
      { name: like },
      { surname: like },
      { phone: like },
      { shipping_guide: like },
      { product_names: like },
      { city: like },
    ];
    if (/^\d+$/.test(texto)) orText.push({ dropi_order_id: Number(texto) });
    where[Op.or] = orText;
  }

  // ── Sync si el cache está viejo (nunca bloquea salvo force_sync) ──
  const integrationKey = getIntegrationKey(integration);
  let syncInfo = { syncedAt: null, ageMinutes: null, syncing: false };
  if (integrationKey && from && until) {
    const lastSync = await DropiOrdersCache.findOne({
      where: {
        ...cacheWhere,
        order_created_at: {
          [Op.between]: [`${from} 00:00:00`, `${until} 23:59:59`],
        },
      },
      order: [['synced_at', 'DESC']],
      attributes: ['synced_at'],
      raw: true,
    });
    const syncedAt = lastSync?.synced_at || null;
    const ageMin = syncedAt
      ? (Date.now() - new Date(syncedAt).getTime()) / 60000
      : null;
    syncInfo = { syncedAt, ageMinutes: ageMin != null ? Math.round(ageMin) : null, syncing: false };

    const stale = ageMin == null || ageMin >= 10;
    const syncArgs = {
      integrationKey,
      country_code: integration.country_code,
      cacheCtx,
      from,
      until,
    };
    if (forceSync && stale) {
      // El botón Actualizar espera el sync (protegido por lock + skip 10min)
      await syncFromDropi(syncArgs).catch((e) =>
        console.error('[pedidos-cache] force sync error:', e?.message),
      );
      syncInfo.ageMinutes = 0;
    } else if (stale) {
      syncInfo.syncing = true;
      setImmediate(() =>
        syncFromDropi(syncArgs).catch((e) =>
          console.error('[pedidos-cache] bg sync error:', e?.message),
        ),
      );
    }
  }

  const { rows, count } = await DropiOrdersCache.findAndCountAll({
    where,
    order: [['order_created_at', 'DESC']],
    limit: pageSize,
    offset: (page - 1) * pageSize,
    attributes: [
      'dropi_order_id',
      'status',
      'classified_status',
      'total_order',
      'name',
      'surname',
      'phone',
      'city',
      'shipping_company',
      'shipping_guide',
      'order_created_at',
      'shop_type',
      'shop_name',
      'order_data',
    ],
    raw: true,
  });

  // ── Parsear productos del order_data ──
  const productIds = new Set();
  const parsed = rows.map((r) => {
    let od = null;
    try {
      od = JSON.parse(r.order_data || 'null');
    } catch (_) {}
    const details = Array.isArray(od?.orderdetails) ? od.orderdetails : [];
    const productos = details.map((d) => {
      const pid = Number(d?.product?.id || 0);
      if (pid) productIds.add(pid);
      return {
        product_id: pid,
        name: d?.product?.name || '',
        sku: d?.product?.sku || '',
        quantity: Number(d?.quantity || 1),
        image: d?.product?.gallery?.[0]?.urlS3 || null, // relativa CDN Dropi
        imagen_catalogo: null, // se llena abajo con productos_chat_center
      };
    });
    return {
      id: Number(r.dropi_order_id),
      name: r.name || '',
      surname: r.surname || '',
      phone: r.phone || '',
      email: od?.client_email || od?.email || '',
      city: r.city || '',
      status: r.status || '',
      classified_status: r.classified_status || '',
      total_order: Number(r.total_order || 0),
      shipping_guide: r.shipping_guide || '',
      shipping_company: r.shipping_company || '',
      order_created_at: r.order_created_at,
      shop_type: r.shop_type || null,
      shop_name: r.shop_name || null,
      productos,
    };
  });

  // ── Teléfono incompleto: alerta + número correcto sugerido ──
  // Dropi no valida el teléfono al editar órdenes pendientes (su form corta el
  // último dígito si lo escriben con el 0 adelante). El clon (la orden que
  // reemplaza a la REEMPLAZADA) queda con número mocho: la transportadora no
  // contacta y el seguimiento no matchea el chat. Detectamos el caso y
  // recuperamos el número desde la gemela REEMPLAZADA (mismo order_created_at)
  // o desde el contacto del chat center cuyo número empieza con esos dígitos.
  const region = integration.country_code;
  for (const o of parsed) {
    o.telefono_incompleto = Boolean(o.phone && !isValidPhone(o.phone, region));
    o.telefono_sugerido = null;
    o.telefono_sugerido_fuente = null;
  }
  const flagged = parsed.filter((o) => o.telefono_incompleto);
  if (flagged.length) {
    const timeOf = (d) => new Date(d).getTime();

    // 1) gemela REEMPLAZADA (el clon hereda el order_created_at exacto)
    try {
      const fechas = [...new Set(flagged.map((o) => o.order_created_at))];
      const twins = await DropiOrdersCache.findAll({
        where: {
          ...cacheWhere,
          status: 'REEMPLAZADA',
          order_created_at: { [Op.in]: fechas },
        },
        attributes: ['phone', 'order_created_at'],
        raw: true,
      });
      for (const o of flagged) {
        const bad = digitsOnly(o.phone);
        const candidates = twins.filter(
          (t) => timeOf(t.order_created_at) === timeOf(o.order_created_at),
        );
        const best =
          candidates.find((t) => {
            const local = toDropiLocal(t.phone, region);
            return isValidPhone(local, region) && local.startsWith(bad);
          }) || candidates.find((t) => isValidPhone(t.phone, region));
        if (best) {
          o.telefono_sugerido = toDropiLocal(best.phone, region);
          o.telefono_sugerido_fuente = 'orden_reemplazada';
        }
      }
    } catch (e) {
      console.error('[pedidos-cache] tel sugerido (gemela):', e?.message);
    }

    // 2) contacto del chat center cuyo número contiene esos dígitos
    const sinSugerencia = flagged.filter((o) => !o.telefono_sugerido);
    if (sinSugerencia.length) {
      try {
        const ors = sinSugerencia.map((o) => ({
          celular_cliente: { [Op.like]: `%${digitsOnly(o.phone)}%` },
        }));
        const contactos = await ClientesChatCenter.findAll({
          where: { id_configuracion, deleted_at: null, [Op.or]: ors },
          attributes: ['celular_cliente'],
          raw: true,
        });
        for (const o of sinSugerencia) {
          const bad = digitsOnly(o.phone);
          const c = contactos.find((x) => {
            const local = toDropiLocal(x.celular_cliente, region);
            return isValidPhone(local, region) && local.startsWith(bad);
          });
          if (c) {
            o.telefono_sugerido = toDropiLocal(c.celular_cliente, region);
            o.telefono_sugerido_fuente = 'contacto';
          }
        }
      } catch (e) {
        console.error('[pedidos-cache] tel sugerido (contacto):', e?.message);
      }
    }
  }

  // ── Imagen del catálogo propio (productos_chat_center.id_dropi) ──
  if (productIds.size) {
    try {
      const cat = await ProductosChatCenter.findAll({
        where: {
          id_configuracion,
          eliminado: 0,
          id_dropi: { [Op.in]: [...productIds] },
        },
        attributes: ['id_dropi', 'imagen_url'],
        raw: true,
      });
      const imgByDropiId = new Map(
        cat
          .filter((c) => c.imagen_url)
          .map((c) => [Number(c.id_dropi), c.imagen_url]),
      );
      for (const o of parsed) {
        for (const p of o.productos) {
          p.imagen_catalogo = imgByDropiId.get(p.product_id) || null;
        }
      }
    } catch (e) {
      console.error('[pedidos-cache] catálogo imgs:', e?.message);
    }
  }

  // ── Estado del pedido: confirmado vs pendiente + creado por el bot ──
  const orderIds = parsed.map((o) => o.id).filter(Boolean);
  let botIds = new Set();
  if (orderIds.length) {
    try {
      const [botRows] = await db.query(
        `SELECT DISTINCT dropi_order_id FROM dropi_auto_ordenes_log
          WHERE id_configuracion = :idCfg AND resultado = 'creada'
            AND dropi_order_id IN (:ids)`,
        { replacements: { idCfg: id_configuracion, ids: orderIds } },
      );
      botIds = new Set(botRows.map((b) => String(b.dropi_order_id)));
    } catch (_) {}
  }
  for (const o of parsed) {
    o.estado_pedido =
      String(o.status).toUpperCase() === 'PENDIENTE CONFIRMACION'
        ? 'pendiente_confirmacion'
        : 'confirmado';
    o.creado_por_bot = botIds.has(String(o.id));
  }

  // ── Origen real: cruce con shopify_ordenes_webhook. El shop_type crudo de
  // Dropi no es confiable (marca SHOPIFY ventas de WA y deja LUCIDBOT/null a
  // órdenes que sí entraron por Shopify). Marca es_shopify por teléfono
  // (últimos 9) + total (±0.5) + ventana ±3d. ──
  try {
    const whRows = await db.query(
      `SELECT phone_normalizado, total_price, shopify_created_at
         FROM shopify_ordenes_webhook
        WHERE id_configuracion = :idCfg AND phone_normalizado IS NOT NULL
          AND shopify_created_at >= DATE_SUB(NOW(), INTERVAL 120 DAY)`,
      { replacements: { idCfg: id_configuracion }, type: db.QueryTypes.SELECT },
    );
    const whByPhone = new Map();
    for (const w of whRows) {
      const p9 = String(w.phone_normalizado).slice(-9);
      if (!whByPhone.has(p9)) whByPhone.set(p9, []);
      whByPhone.get(p9).push({
        total: Number(w.total_price),
        t: w.shopify_created_at ? new Date(w.shopify_created_at).getTime() : null,
      });
    }
    const WIN = 3 * 24 * 60 * 60 * 1000;
    for (const o of parsed) {
      const p9 = String(o.phone || '')
        .replace(/\D/g, '')
        .slice(-9);
      const list = p9 ? whByPhone.get(p9) : null;
      const t = o.order_created_at
        ? new Date(o.order_created_at).getTime()
        : null;
      o.es_shopify = list
        ? list.some(
            (w) =>
              Math.abs(w.total - o.total_order) < 0.5 &&
              (t == null || w.t == null || Math.abs(w.t - t) <= WIN),
          )
        : false;
    }
  } catch (_) {
    for (const o of parsed) if (o.es_shopify == null) o.es_shopify = false;
  }

  // ── Chat + agente (mismo enricher del listado en vivo) ──
  // Para el match usamos el número sugerido cuando el de la orden está
  // incompleto: así la orden truncada recupera su conversación/agente en vez
  // de quedar "Sin conversación". El phone visible sigue siendo el de Dropi.
  const paraMatch = parsed.map((o) =>
    o.telefono_incompleto && o.telefono_sugerido
      ? { ...o, phone: o.telefono_sugerido }
      : o,
  );
  const enriched = (
    await enrichOrdersWithChatAndAgent({
      id_configuracion,
      objects: paraMatch,
    })
  ).map((o, i) => ({ ...o, phone: parsed[i].phone }));

  return res.json({
    isSuccess: true,
    data: {
      rows: enriched,
      total: count,
      page,
      page_size: pageSize,
      total_pages: Math.max(1, Math.ceil(count / pageSize)),
      sync: syncInfo,
    },
  });
});

exports.listProductsIndex = catchAsync(async (req, res, next) => {
  const id_configuracion = toInt(req.body?.id_configuracion);
  if (!id_configuracion)
    return next(new AppError('id_configuracion es requerido', 400));

  const integration = await getActiveIntegration(id_configuracion);
  if (!integration)
    return next(new AppError('No existe una integración Dropi activa', 404));

  const integrationKey = getIntegrationKey(integration);
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

  const integrationKey = getIntegrationKey(integration);
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

  const integrationKey = getIntegrationKey(integration);
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

function getIntegrationKey(integration) {
  try {
    return decryptToken(integration.integration_key_enc);
  } catch (err) {
    return null;
  }
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
      shop_id: o.shop_id ?? o.shop?.id ?? null,
      shop_type: o.shop?.type ?? null,
      shop_name: o.shop?.name ?? null,
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
        'shop_id',
        'shop_type',
        'shop_name',
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

  // ── chat_id_cliente por teléfono para el botón "Abrir chat" del board.
  // Solo aplica a integraciones con configuración (el chat vive por
  // config); las user-level no tienen chat center asociado. Las entradas
  // de retiroAgencia comparten referencia con ordersByStatus, pero las
  // recorremos aparte por las que exceden el tope de 25 por estado.
  if (cacheCtx.id_configuracion) {
    const chatKeys = new Set();
    const listas = [...Object.values(ordersByStatus), retiroAgencia];
    for (const list of listas) {
      for (const o of list) for (const k of phoneKeys(o.phone)) chatKeys.add(k);
    }
    if (chatKeys.size) {
      const chatMap = await fetchClientPhoneMap(
        cacheCtx.id_configuracion,
        chatKeys,
      );
      for (const list of listas) {
        for (const o of list) {
          if (o.chat_id_cliente) continue;
          for (const k of phoneKeys(o.phone)) {
            const cid = chatMap.get(k);
            if (cid) {
              o.chat_id_cliente = cid;
              break;
            }
          }
        }
      }
    }
  }

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
  const integration_id = toInt(
    req.body?.integration_id || req.query?.integration_id,
  );
  const id_configuracion = toInt(
    req.body?.id_configuracion || req.query?.id_configuracion,
  );
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

  const integrationKey = getIntegrationKey(integration);
  if (!integrationKey) return next(new AppError('Dropi key inválida', 400));

  const from = strOrNull(req.body?.from || req.query?.from);
  const until = strOrNull(req.body?.until || req.query?.until);
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

  const integrationKey = getIntegrationKey(integration);
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

  const integrationKey = getIntegrationKey(integration);
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
  console.log('Resolviendo query:   ', {
    integration_id: req.body?.integration_id || req.query?.integration_id,
    id_configuracion: req.body?.id_configuracion || req.query?.id_configuracion,
    id_usuario: req.sessionUser?.id_usuario,
  });

  console.log('query:', req.query);

  const integration_id = toInt(
    req.body?.integration_id || req.query?.integration_id,
  );
  console.log('Resolviendo cacheCtx para integration_id:', integration_id);
  const id_configuracion = toInt(
    req.body?.id_configuracion || req.query?.id_configuracion,
  );
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
  const tasaEntregaHist =
    _totalMovilizadas > 0 ? _totalEntregadas / _totalMovilizadas : 0.6; // default 60% si no hay data
  // Ticket promedio (venta entregadas / órdenes entregadas)
  const ticketPromedio =
    _totalEntregadas > 0 ? _totalVentaEnt / _totalEntregadas : 0;
  // % costo histórico = costo / venta (típico 30-50% en dropshipping)
  const pctCostoHist =
    _totalVentaEnt > 0 ? _totalCostoEnt / _totalVentaEnt : 0.5;
  // % flete histórico por entrega = flete_entregadas / venta_entregadas (típico 5-15%)
  const pctFleteHist =
    _totalVentaEnt > 0 ? _totalFleteEnt / _totalVentaEnt : 0.1;

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
    const gastosAdicionales = Number(manual.gastos_adicionales || 0);

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
      ventaEntregadas -
      costoProductoEntregadas -
      fleteMovilizadas -
      gasto -
      gastosAdicionales;

    // ─────── PROYECCIÓN ───────
    // De las órdenes en tránsito, asumimos que se entregarán según tasa histórica.
    // Esa entrega futura genera venta extra que TODAVÍA no se contabiliza pero el flete ya se gastó.
    const ordenesProyectadasEntregar = transitoOrdenes * tasaEntregaHist;
    const ventaProyectadaExtra = ordenesProyectadasEntregar * ticketPromedio;
    const costoProyectadoExtra = ventaProyectadaExtra * pctCostoHist;
    // El flete ya está incluido en flete_movilizadas (cuenta tránsito), no lo sumamos otra vez
    const rentabilidadProyectadaExtra =
      ventaProyectadaExtra - costoProyectadoExtra;
    const rentabilidadProyectada = rentabilidad + rentabilidadProyectadaExtra;

    // Tasa entrega LOCAL del día (sobre movilizadas, no sobre total)
    const movDia = Number(r.movilizadas || 0);
    const tasaEntregaDia =
      movDia > 0 ? Number(r.entregadas || 0) / movDia : null;

    return {
      fecha: fechaStr,
      gasto_diario: Math.round(gasto * 100) / 100,
      num_mensajes: mensajes,
      gastos_adicionales: Math.round(gastosAdicionales * 100) / 100,
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
      tasa_entrega_dia:
        tasaEntregaDia !== null ? Math.round(tasaEntregaDia * 1000) / 10 : null, // 0..100
      rentabilidad: Math.round(rentabilidad * 100) / 100,
      // Nuevos campos de proyección
      rentabilidad_proyectada: Math.round(rentabilidadProyectada * 100) / 100,
      venta_proyectada_extra: Math.round(ventaProyectadaExtra * 100) / 100,
      ordenes_proyectadas_extra:
        Math.round(ordenesProyectadasEntregar * 10) / 10,
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
    const gastosAdic = Number(m.gastos_adicionales || 0);
    if (gasto === 0 && mensajes === 0 && gastosAdic === 0) continue;
    rows.push({
      fecha: fechaStr,
      gasto_diario: Math.round(gasto * 100) / 100,
      num_mensajes: mensajes,
      gastos_adicionales: Math.round(gastosAdic * 100) / 100,
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
      rentabilidad: -(gasto + gastosAdic),
      rentabilidad_proyectada: -(gasto + gastosAdic),
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
      gastos_adicionales: acc.gastos_adicionales + (r.gastos_adicionales || 0),
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
      rentabilidad_proyectada:
        acc.rentabilidad_proyectada + (r.rentabilidad_proyectada || 0),
      venta_proyectada_extra:
        acc.venta_proyectada_extra + (r.venta_proyectada_extra || 0),
      ordenes_proyectadas_extra:
        acc.ordenes_proyectadas_extra + (r.ordenes_proyectadas_extra || 0),
    }),
    {
      gasto_diario: 0,
      num_mensajes: 0,
      gastos_adicionales: 0,
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
  totales.tasa_entrega =
    totales.movilizadas > 0
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
  const gastos_adicionales = req.body?.gastos_adicionales;

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
  if (gastos_adicionales !== undefined)
    row.gastos_adicionales = Number(gastos_adicionales) || 0;
  await row.save();

  return res.json({
    isSuccess: true,
    data: {
      fecha: row.fecha,
      gasto_diario: Number(row.gasto_diario),
      num_mensajes: Number(row.num_mensajes),
      gastos_adicionales: Number(row.gastos_adicionales),
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
      margen_bruto:
        Math.round(
          (ventaEntregadas - costoEntregadas - fleteMovilizadas) * 100,
        ) / 100,
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
        idCfg,
        idUsr,
        minOrd: minOrdenes,
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
      alertas.push(
        `Tasa de entrega ${tasaEnt}% — por debajo del promedio del rango`,
      );
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
      ultima_orden: r.ultima_orden
        ? r.ultima_orden.toString().slice(0, 10)
        : null,
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
  if (ordenarPor === 'devueltas')
    orderClause = 'devueltas DESC, ordenes_total DESC';
  else if (ordenarPor === 'tasa_entrega_asc')
    orderClause = 'tasa_entrega ASC, ordenes_total DESC';
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
        idCfg,
        idUsr,
        minOrd: minOrdenes,
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

  return res.json({
    isSuccess: true,
    data: { ciudades, total_ciudades: ciudades.length },
  });
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
      replacements: {
        idCfg,
        idUsr,
        minOrd: minOrdenes,
        from: `${from} 00:00:00`,
        until: `${until} 23:59:59`,
      },
    },
  );

  const productos = rows.map((r) => {
    const ventaEnt = Number(r.venta_entregadas || 0); // Lo que el dropshipper cobró al cliente final
    const costoEnt = Number(r.costo_entregadas || 0); // Lo que pagó a IMPORSHOP por el producto
    const fleteMov = Number(r.flete_movilizadas || 0); // Lo que pagó al courier
    const ordenes = Number(r.ordenes || 0);
    const entregadas = Number(r.ordenes_entregadas || 0);
    const movilizadas = Number(r.movilizadas || 0);
    const rentabilidad = ventaEnt - costoEnt - fleteMov;
    const tasaEnt =
      movilizadas > 0
        ? Math.round((entregadas / movilizadas) * 1000) / 10
        : null;
    const ticketPromedio = entregadas > 0 ? ventaEnt / entregadas : 0;
    const margenPorcentaje =
      ventaEnt > 0 ? Math.round((rentabilidad / ventaEnt) * 1000) / 10 : null;
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
  const positivos = productos.filter((p) => p.rentabilidad > 0).length;
  const negativos = productos.filter((p) => p.rentabilidad < 0).length;

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
        margen_pct_global:
          totalVenta > 0
            ? Math.round((totalRent / totalVenta) * 1000) / 10
            : null,
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
  const minOrdenes =
    Number(req.query?.min_ordenes || req.body?.min_ordenes) || 5;
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
        idCfg,
        idUsr,
        from: `${from} 00:00:00`,
        until: `${until} 23:59:59`,
      },
    },
  );

  // Paso 2: agrupar en mapa por ciudad
  const mapaGlobal = {};
  for (const r of rows) {
    const city = r.city;
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
      ordenes: Number(r.total_ordenes || 0),
      entregadas: Number(r.entregadas || 0),
      devoluciones: Number(r.devoluciones || 0),
      canceladas: Number(r.canceladas || 0),
      en_transito: Number(r.en_transito || 0),
      ticket_promedio: Math.round(Number(r.ticket_promedio || 0) * 100) / 100,
      tasa_entrega_pct: Number(r.tasa_entrega_pct || 0),
    };
    mapaGlobal[city].total_ordenes += t.ordenes;
    mapaGlobal[city].entregadas += t.entregadas;
    mapaGlobal[city].devoluciones += t.devoluciones;
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
        ? conMasa.reduce(
            (best, t) =>
              t.tasa_entrega_pct > best.tasa_entrega_pct ? t : best,
            conMasa[0],
          )
        : null;

      const peor = conMasa.length
        ? conMasa.reduce(
            (worst, t) =>
              t.tasa_entrega_pct < worst.tasa_entrega_pct ? t : worst,
            conMasa[0],
          )
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
        recomendacion =
          'Insuficientes datos por courier para recomendar (mín 5 órdenes por courier).';
      }

      const finalizadas = c.entregadas + c.devoluciones;
      const tasa_ciudad =
        finalizadas > 0
          ? Math.round((c.entregadas / finalizadas) * 1000) / 10
          : null;

      return {
        ciudad: c.ciudad,
        total_ordenes: c.total_ordenes,
        entregadas: c.entregadas,
        devoluciones: c.devoluciones,
        tasa_ciudad_pct: tasa_ciudad,
        mejor_courier: mejor
          ? { courier: mejor.courier, tasa: mejor.tasa_entrega_pct }
          : null,
        peor_courier:
          peor && peor.courier !== mejor?.courier
            ? { courier: peor.courier, tasa: peor.tasa_entrega_pct }
            : null,
        recomendacion,
        transportadoras: c.transportadoras,
      };
    })
    .sort((a, b) => b.total_ordenes - a.total_ordenes);

  return res.json({
    isSuccess: true,
    data: {
      ciudades,
      total_ciudades: ciudades.length,
      min_ordenes: minOrdenes,
    },
  });
});

/* ═══════════════════════════════════════════════════════════
   Conversaciones por producto
   conversaciones      → orden.phone → clientes_chat_center.celular_cliente
                         (últimos 9 díg) = chats distintos que PIDIERON el
                         producto (solo compradores, por eso ≈ ordenes)
   conversacionesTotal → lo anterior ∪ chats que ENTRARON por un anuncio
                         del producto en el periodo (cliente_productos_ad).
                         El anuncio se atribuye a un producto en cascada:
                         a) headline = nombre del producto,
                         b) mayoría: qué compraron los clientes de ese
                            anuncio (headlines genéricos tipo "envío
                            gratis" quedan cubiertos por esta vía),
                         c) mensaje prellenado del CTWA ("Quiero comprar
                            el ..."), fila por fila.
   pctConfirmacion     → depende del rubro del producto:
     · con anuncios CTWA (el cliente escribe primero):
         conversaciones ÷ conversacionesTotal
         "de los que escribieron, cuántos pidieron"
     · Shopify con webhook (NOSOTROS escribimos primero a confirmar):
         confirmadas ÷ ordenes  (status ≠ PENDIENTE CONFIRMACION)
         "de los pedidos, cuántos se confirmaron"; conversacionesTotal
         = contactados (chats vinculados a órdenes del producto)
     · sin ninguna de las dos señales → null ("—" en el front)
     · FAMILIA de variantes: si los clientes de un mismo anuncio
       compraron VARIOS productos (unidad + combos del mismo
       producto), cada comprador cuenta en la fila de lo que
       realmente compró (dato real del order_data) y el total de
       conversaciones del anuncio se comparte a nivel familia:
       pct = compraron alguna presentación ÷ escribieron.
   pctConfirmacionTipo → 'chat' | 'ordenes' | 'familia' | null
   familia / familiaN   → nombre del anuncio y nº de presentaciones
                          (solo en filas tipo 'familia')
   ═══════════════════════════════════════════════════════════ */
async function attachProductConversations({
  id_configuracion,
  orderRows,
  productos,
  from,
  until,
  hasShopifyTruth = false,
  clientByKey = null,
  adRows = null,
}) {
  const productKeys = new Map(); // name → Set(phoneKey)
  const productsByKey = new Map(); // phoneKey → Set(product name)
  const allKeys = new Set();

  for (const o of orderRows) {
    if (!o.phone) continue;
    const ks = phoneKeys(o.phone);
    if (!ks.length) continue;
    let names = [];
    try {
      names = JSON.parse(o.product_names || '[]');
    } catch (_) {}
    for (const name of names) {
      if (!productKeys.has(name)) productKeys.set(name, new Set());
      ks.forEach((k) => {
        productKeys.get(name).add(k);
        allKeys.add(k);
        if (!productsByKey.has(k)) productsByKey.set(k, new Set());
        productsByKey.get(k).add(name);
      });
    }
  }

  if (!clientByKey) {
    clientByKey = await fetchClientPhoneMap(id_configuracion, allKeys);
  }

  // ── Chats que entraron por anuncio en el periodo (CTWA) ──
  // Normalmente viene prefetcheada desde el Promise.all principal de
  // getConnectionSummary (para no sumar su latencia en serie); el
  // fallback consulta aquí. .catch → la tabla puede no existir aún.
  if (!adRows) {
    [adRows] = await db
      .query(
        `SELECT cpa.id_cliente, cpa.source_id, cpa.headline,
                cpa.mensaje_cliente, cc.celular_cliente
           FROM cliente_productos_ad cpa
           JOIN clientes_chat_center cc
             ON cc.id = cpa.id_cliente AND cc.deleted_at IS NULL
          WHERE cpa.id_configuracion = :idCfg
            AND cpa.created_at BETWEEN :from AND :until`,
        { replacements: { idCfg: id_configuracion, from, until } },
      )
      .catch(() => [[]]);
  }

  // Agrupar filas por anuncio (source_id; sin él, por headline)
  const adGroups = new Map(); // adKey → { headline, rows, clients: Map(id → keys) }
  for (const r of adRows) {
    if (!r.id_cliente) continue;
    const adKey = r.source_id || `h:${r.headline || ''}`;
    if (!adGroups.has(adKey))
      adGroups.set(adKey, { headline: r.headline, rows: [], clients: new Map() });
    const g = adGroups.get(adKey);
    g.rows.push(r);
    if (!g.clients.has(r.id_cliente))
      g.clients.set(r.id_cliente, phoneKeys(r.celular_cliente));
  }

  const totalByProduct = new Map(); // product name → Set(id_cliente)
  const addConv = (name, cid) => {
    if (!totalByProduct.has(name)) totalByProduct.set(name, new Set());
    totalByProduct.get(name).add(cid);
  };
  const msgMatch = new Map(); // mensaje → product name | null (cache)
  const matchMensaje = (msg) => {
    const key = String(msg || '').trim();
    if (!key) return null;
    if (!msgMatch.has(key)) {
      const prod = matchEnLista(productos, key, (p) => p.name);
      msgMatch.set(key, prod ? prod.name : null);
    }
    return msgMatch.get(key);
  };

  const familias = []; // { nombre, members:Set(name), clients:Set(cid) }

  for (const g of adGroups.values()) {
    // a) headline = nombre del producto
    let prodName =
      matchEnLista(productos, g.headline, (p) => p.name)?.name || null;

    // compras REALES de cada cliente del anuncio (order_data)
    const boughtByClient = new Map(); // cid → Set(product name)
    for (const [cid, ks] of g.clients) {
      const bought = new Set();
      for (const k of ks) {
        for (const name of productsByKey.get(k) || []) bought.add(name);
      }
      boughtByClient.set(cid, bought);
    }

    // b) mayoría: producto que compraron los clientes de este anuncio
    if (!prodName) {
      const tally = new Map();
      let links = 0;
      for (const bought of boughtByClient.values()) {
        for (const name of bought) {
          tally.set(name, (tally.get(name) || 0) + 1);
          links += 1;
        }
      }
      let best = null;
      let bestN = 0;
      for (const [name, n] of tally) {
        if (n > bestN) {
          best = name;
          bestN = n;
        }
      }
      if (best && bestN >= 2 && bestN / links >= 0.6) prodName = best;
    }

    if (prodName) {
      // ¿El anuncio vende una FAMILIA? (los clientes compraron otras
      // presentaciones además de la que matchea el headline: unidad
      // + combos del mismo producto)
      const members = new Set([prodName]);
      for (const bought of boughtByClient.values()) {
        for (const name of bought) members.add(name);
      }

      if (members.size >= 2) {
        // comprador → su producto REAL; el total del anuncio se
        // comparte a nivel familia (los que no compraron no se
        // pueden asignar a una presentación específica)
        const fam = { nombre: g.headline || prodName, members, clients: new Set() };
        for (const [cid, bought] of boughtByClient) {
          fam.clients.add(cid);
          for (const name of bought) addConv(name, cid);
        }
        familias.push(fam);
      } else {
        for (const cid of g.clients.keys()) addConv(prodName, cid);
      }
      continue;
    }

    // c) anuncio sin resolver → mensaje prellenado, fila por fila
    for (const r of g.rows) {
      const name = matchMensaje(r.mensaje_cliente);
      if (name) addConv(name, r.id_cliente);
    }
  }

  // Fusionar familias que comparten alguna presentación (varios
  // anuncios del mismo producto → una sola familia)
  const familiasMerged = [];
  for (const fam of familias) {
    const hit = familiasMerged.find((f) =>
      [...fam.members].some((m) => f.members.has(m)),
    );
    if (hit) {
      for (const m of fam.members) hit.members.add(m);
      for (const c of fam.clients) hit.clients.add(c);
    } else {
      familiasMerged.push(fam);
    }
  }
  const famByProduct = new Map(); // name → familia
  for (const fam of familiasMerged) {
    for (const name of fam.members) famByProduct.set(name, fam);
  }

  const buyersByProduct = new Map(); // name → Set(id_cliente con orden)
  for (const p of productos) {
    const buyers = new Set();
    for (const k of productKeys.get(p.name) || []) {
      const cid = clientByKey.get(k);
      if (cid) buyers.add(cid);
    }
    buyersByProduct.set(p.name, buyers);
    p.conversaciones = buyers.size;
  }

  for (const p of productos) {
    const buyers = buyersByProduct.get(p.name);
    const fam = famByProduct.get(p.name);
    const adSet = totalByProduct.get(p.name);
    if (fam) {
      // Familia de variantes: el total del anuncio se comparte entre
      // las presentaciones; el % mide cuántos de los que escribieron
      // compraron ALGUNA presentación. "Con pedido" sigue siendo el
      // dato real de ESTA fila.
      const total = new Set(fam.clients);
      const conAlguna = new Set();
      for (const name of fam.members) {
        for (const cid of buyersByProduct.get(name) || []) {
          total.add(cid);
          conAlguna.add(cid);
        }
      }
      p.conversacionesTotal = total.size;
      p.pctConfirmacion = total.size
        ? Math.round((conAlguna.size / total.size) * 10000) / 100
        : null;
      p.pctConfirmacionTipo = 'familia';
      p.familia = fam.nombre;
      p.familiaN = [...fam.members].filter((n) =>
        buyersByProduct.has(n),
      ).length;
    } else if (adSet && adSet.size) {
      // Rubro CTWA: el cliente escribe primero. Embudo:
      // escribieron → pidieron.
      const total = new Set(buyers);
      for (const cid of adSet) total.add(cid);
      p.conversacionesTotal = total.size;
      p.pctConfirmacion = Math.round((buyers.size / total.size) * 10000) / 100;
      p.pctConfirmacionTipo = 'chat';
    } else if (hasShopifyTruth && p.ordenes > 0) {
      // Rubro Shopify: NOSOTROS escribimos primero para confirmar el
      // pedido COD. conversacionesTotal = contactados en el chat;
      // el % mide cuántos pedidos quedaron confirmados.
      p.conversacionesTotal = buyers.size;
      p.pctConfirmacion =
        Math.round(((p.confirmadas || 0) / p.ordenes) * 10000) / 100;
      p.pctConfirmacionTipo = 'ordenes';
    } else {
      // Sin anuncios del producto ni webhook Shopify: no hay embudo
      // medible; conv. totales ≈ compradores daría un 100% falso.
      p.conversacionesTotal = null;
      p.pctConfirmacion = null;
      p.pctConfirmacionTipo = null;
    }
  }

  // true → hubo tráfico de anuncios CTWA en el periodo; sin esto,
  // conversacionesTotal ≈ compradores y el % de confirmación engaña
  // (el front oculta esas columnas e invita a conectar la cuenta ads).
  return adRows.length > 0;
}

/* Conversaciones por canal: clientes de chat distintos vinculados por
   teléfono a las órdenes de cada canal (WA vs Shopify). Así el KPI de
   conversaciones del front cambia al filtrar por canal. */
async function countCanalConversaciones({
  id_configuracion,
  orderRows,
  esOrdenShopify,
  clientByKey = null,
}) {
  const keysByCanal = { wa: new Set(), shopify: new Set() };
  const allKeys = new Set();
  const isShopify = esOrdenShopify || ((o) => o.shop_type === 'SHOPIFY');

  for (const o of orderRows) {
    if (!o.phone) continue;
    const ks = phoneKeys(o.phone);
    if (!ks.length) continue;
    const canal = isShopify(o) ? 'shopify' : 'wa';
    ks.forEach((k) => {
      keysByCanal[canal].add(k);
      allKeys.add(k);
    });
  }

  const out = { wa: 0, shopify: 0 };
  if (!allKeys.size) return out;

  if (!clientByKey) {
    clientByKey = await fetchClientPhoneMap(id_configuracion, allKeys);
  }

  for (const canal of ['wa', 'shopify']) {
    const cset = new Set();
    for (const k of keysByCanal[canal]) {
      const cid = clientByKey.get(k);
      if (cid) cset.add(cid);
    }
    out[canal] = cset.size;
  }
  return out;
}

/* ⚙️ Validación de canal Shopify contra el webhook real.
   false → canal = shop_type crudo de Dropi (comportamiento original),
           para comparar métricas mientras shopify_ordenes_webhook se llena.
   true  → una orden solo cuenta como Shopify si hace match con una orden
           real del webhook (teléfono + total ±0.5 + ventana 72h).
   Encendido 2026-07-16: el shop_type de Dropi dejó de ser confiable en
   ambos sentidos — marca SHOPIFY ventas de WA y, peor, órdenes que SÍ son
   de Shopify llegan como LUCIDBOT/null cuando entran por integradores
   (cfg 277: 0 órdenes 'SHOPIFY' desde el 1/jul pese a vender por Shopify;
   con el webhook matchean 13/77 en 48h). Solo aplica a tiendas con filas
   en shopify_ordenes_webhook dentro del rango; el resto sigue con el
   shop_type crudo. */
const VALIDAR_SHOPIFY_CON_WEBHOOK = true;

/* ═══════════════════════════════════════════════════════════
   getConnectionSummary
   KPIs + top productos para una conexión en un rango de fechas.
   ═══════════════════════════════════════════════════════════ */

exports.getConnectionSummary = catchAsync(async (req, res, next) => {
  const id_configuracion = toInt(req.body?.id_configuracion);
  const from = strOrNull(req.body?.from);
  const until = strOrNull(req.body?.until);

  if (!id_configuracion)
    return next(new AppError('id_configuracion es requerido', 400));
  if (!from || !until)
    return next(new AppError('from y until son requeridos', 400));

  const r2 = (n) => Math.round(Number(n || 0) * 100) / 100;
  const fromDt = `${from} 00:00:00`;
  const untilDt = `${until} 23:59:59`;
  const dateRange = { [Op.between]: [fromDt, untilDt] };
  const repl = { idCfg: id_configuracion, from: fromDt, until: untilDt };

  const [
    orderRows,
    [botRows],
    [convRows],
    [activeConvRows],
    [msgRows],
    [carritoRows],
    [dailyRows],
    [prodRows],
    [metaAdsRows],
    [shopifyOrdRows],
    [clientPhoneRows],
    [ctwaAdRows],
  ] = await Promise.all([
    DropiOrdersCache.findAll({
      where: { id_configuracion, id_usuario: 0, order_created_at: dateRange },
      attributes: [
        'dropi_order_id',
        'total_order',
        'dropshipper_profit',
        'status',
        'classified_status',
        'shop_type',
        'phone',
        'product_names',
        'order_created_at',
        [fn('DATE_FORMAT', col('order_created_at'), '%Y-%m-%d'), 'dia'],
      ],
      raw: true,
    }),
    // Órdenes creadas por el bot (venta WA)
    db.query(
      `SELECT DISTINCT dropi_order_id FROM dropi_auto_ordenes_log
        WHERE id_configuracion = :idCfg AND resultado = 'creada'
          AND dropi_order_id IS NOT NULL AND created_at BETWEEN :from AND :until`,
      { replacements: repl },
    ),
    // Conversaciones nuevas por día
    db.query(
      `SELECT DATE_FORMAT(created_at,'%Y-%m-%d') AS dia, COUNT(*) AS n FROM clientes_chat_center
        WHERE id_configuracion = :idCfg AND deleted_at IS NULL
          AND created_at BETWEEN :from AND :until GROUP BY DATE_FORMAT(created_at,'%Y-%m-%d')`,
      { replacements: repl },
    ),
    // Conversaciones ACTIVAS: clientes distintos que escribieron en el
    // periodo (celular_recibe = id del cliente, pese al nombre). El KPI
    // usa esto y no solo "nuevas": los clientes antiguos que vuelven a
    // escribir también cuentan (los productos de abajo los incluyen, y
    // sin esto la suma por producto podía superar al total del hero).
    db.query(
      `SELECT COUNT(DISTINCT celular_recibe) AS n FROM mensajes_clientes
        WHERE id_configuracion = :idCfg AND deleted_at IS NULL AND rol_mensaje = 0
          AND created_at BETWEEN :from AND :until`,
      { replacements: repl },
    ),
    // Mensajes entrantes por día (rol_mensaje = 0 → escribió el cliente)
    db.query(
      `SELECT DATE_FORMAT(created_at,'%Y-%m-%d') AS dia, COUNT(*) AS n FROM mensajes_clientes
        WHERE id_configuracion = :idCfg AND deleted_at IS NULL AND rol_mensaje = 0
          AND created_at BETWEEN :from AND :until GROUP BY DATE_FORMAT(created_at,'%Y-%m-%d')`,
      { replacements: repl },
    ),
    // Carritos abandonados Shopify
    db.query(
      `SELECT COUNT(*) AS abandonados, SUM(recuperado = 1) AS recuperados,
              SUM(CASE WHEN recuperado = 1 THEN total_price ELSE 0 END) AS valor_recuperado
         FROM shopify_carritos_abandonados
        WHERE id_configuracion = :idCfg AND shopify_created_at BETWEEN :from AND :until`,
      { replacements: repl },
    ),
    // Serie diaria (fechas locales con DATE_FORMAT → sin desfase de zona horaria)
    db.query(
      `SELECT DATE_FORMAT(order_created_at,'%Y-%m-%d') AS dia,
              COUNT(*) AS pedidos,
              SUM(CASE WHEN shop_type = 'SHOPIFY' THEN 1 ELSE 0 END) AS pedidos_shopify,
              SUM(total_order) AS facturado,
              SUM(COALESCE(dropshipper_profit,0)) AS ganancia,
              SUM(CASE WHEN classified_status='entregada' THEN 1 ELSE 0 END) AS entregadas
         FROM dropi_orders_cache
        WHERE id_configuracion = :idCfg AND id_usuario = 0 AND order_created_at BETWEEN :from AND :until
        GROUP BY DATE_FORMAT(order_created_at,'%Y-%m-%d')`,
      { replacements: repl },
    ),
    // Productos vendidos en el periodo (prorrateo dropshipper + imagen)
    db.query(
      `WITH order_subtotals AS (
        SELECT c.id AS order_id, c.classified_status, c.status, c.total_order,
          COALESCE(CAST(JSON_UNQUOTE(JSON_EXTRACT(c.order_data,'$.shipping_amount')) AS DECIMAL(10,2)),0) AS shipping_amount,
          (SELECT SUM(x.qty * x.sp) FROM JSON_TABLE(c.order_data,'$.orderdetails[*]' COLUMNS (
            qty INT PATH '$.quantity', sp DECIMAL(10,2) PATH '$.product.sale_price')) AS x) AS subtotal_items
        FROM dropi_orders_cache c
        WHERE c.id_configuracion = :idCfg AND c.id_usuario = 0 AND c.order_created_at BETWEEN :from AND :until
      )
      SELECT jt.product_id, jt.product_name, jt.sku,
        MAX(jt.image) AS image,
        COUNT(DISTINCT os.order_id) AS ordenes,
        COUNT(DISTINCT CASE WHEN os.status <> 'PENDIENTE CONFIRMACION' THEN os.order_id END) AS ordenes_confirmadas,
        SUM(jt.quantity) AS unidades,
        SUM(CASE WHEN os.classified_status='entregada' THEN 1 ELSE 0 END) AS ordenes_entregadas,
        SUM(CASE WHEN os.classified_status='devolucion' THEN 1 ELSE 0 END) AS devoluciones,
        SUM(CASE WHEN os.classified_status='cancelada' THEN 1 ELSE 0 END) AS canceladas,
        SUM(CASE WHEN os.classified_status IN ('en_transito','en_reparto','novedad','retiro_agencia','guia_generada','pendiente') THEN 1 ELSE 0 END) AS transito,
        SUM(CASE WHEN os.classified_status IN ('entregada','devolucion','en_transito','en_reparto','novedad','retiro_agencia') THEN 1 ELSE 0 END) AS movilizadas,
        SUM(CASE WHEN os.classified_status='entregada' THEN (jt.quantity*jt.sale_price) ELSE 0 END) AS costo_entregadas,
        SUM(CASE WHEN os.classified_status='entregada' AND os.subtotal_items>0
                THEN os.total_order*((jt.quantity*jt.sale_price)/os.subtotal_items) ELSE 0 END) AS venta_entregadas,
        SUM(CASE WHEN os.classified_status IN ('entregada','devolucion','en_transito','en_reparto','novedad','retiro_agencia') AND os.subtotal_items>0
                THEN os.shipping_amount*((jt.quantity*jt.sale_price)/os.subtotal_items) ELSE 0 END) AS flete_movilizadas
      FROM order_subtotals os,
      JSON_TABLE((SELECT order_data FROM dropi_orders_cache WHERE id = os.order_id),
        '$.orderdetails[*]' COLUMNS (
          product_id INT PATH '$.product.id', product_name VARCHAR(300) PATH '$.product.name',
          sku VARCHAR(100) PATH '$.product.sku', sale_price DECIMAL(10,2) PATH '$.product.sale_price',
          quantity INT PATH '$.quantity',
          image VARCHAR(500) PATH '$.product.gallery[0].urlS3')) AS jt
      GROUP BY jt.product_id, jt.product_name, jt.sku`,
      { replacements: repl },
    ),
    // Estado de vinculación Meta Ads (para CTA / anuncios ganadores en el front)
    db.query(
      `SELECT ad_account_name FROM meta_ad_connections
        WHERE id_configuracion = :idCfg AND status = 'active'
        ORDER BY id DESC LIMIT 1`,
      { replacements: repl },
    ),
    // Fuente de verdad Shopify: órdenes reales recibidas por el webhook
    // orders/create. Si hay filas, el canal se valida contra esto (el
    // shop_type de Dropi marca SHOPIFY órdenes que entraron por WA).
    // .catch → la tabla puede no existir aún en este entorno.
    db
      .query(
        `SELECT phone_normalizado, total_price, shopify_created_at, created_at
           FROM shopify_ordenes_webhook
          WHERE id_configuracion = :idCfg
            AND created_at BETWEEN DATE_SUB(:from, INTERVAL 3 DAY)
                               AND DATE_ADD(:until, INTERVAL 1 DAY)`,
        { replacements: repl },
      )
      .catch(() => [[]]),
    // Clientes del chat cuyos teléfonos (últimos 9 dígitos) aparecen en
    // las órdenes del rango. Mapa COMPARTIDO por attachProductConversations
    // y countCanalConversaciones: antes cada una lanzaba su propio
    // LIKE-OR de ~1.4s sobre clientes_chat_center.
    db.query(
      `SELECT cc.id, cc.celular_cliente
         FROM clientes_chat_center cc
        WHERE cc.id_configuracion = :idCfg AND cc.deleted_at IS NULL
          AND RIGHT(REGEXP_REPLACE(cc.celular_cliente,'[^0-9]',''),9) IN (
            SELECT DISTINCT RIGHT(REGEXP_REPLACE(o.phone,'[^0-9]',''),9)
                     COLLATE utf8mb4_unicode_ci
              FROM dropi_orders_cache o
             WHERE o.id_configuracion = :idCfg AND o.id_usuario = 0
               AND o.order_created_at BETWEEN :from AND :until
               AND o.phone IS NOT NULL)
        ORDER BY cc.id`,
      { replacements: repl },
    ),
    // Chats entrados por anuncio CTWA (los usa attachProductConversations;
    // prefetch aquí para que su ~0.5-1s corra en paralelo y no en serie).
    // .catch → la tabla puede no existir aún en este entorno.
    db
      .query(
        `SELECT cpa.id_cliente, cpa.source_id, cpa.headline,
                cpa.mensaje_cliente, cc.celular_cliente
           FROM cliente_productos_ad cpa
           JOIN clientes_chat_center cc
             ON cc.id = cpa.id_cliente AND cc.deleted_at IS NULL
          WHERE cpa.id_configuracion = :idCfg
            AND cpa.created_at BETWEEN :from AND :until`,
        { replacements: repl },
      )
      .catch(() => [[]]),
  ]);

  const clientByKey = new Map();
  for (const c of clientPhoneRows) {
    for (const k of phoneKeys(c.celular_cliente)) {
      if (!clientByKey.has(k)) clientByKey.set(k, c.id);
    }
  }

  const botOrderIds = new Set(botRows.map((r) => String(r.dropi_order_id)));
  const convByDay = new Map(
    convRows.map((r) => [String(r.dia), Number(r.n || 0)]),
  );
  const msgByDay = new Map(
    msgRows.map((r) => [String(r.dia), Number(r.n || 0)]),
  );
  // Nuevas del periodo (para la serie diaria) vs activas (KPI del hero):
  // activas ⊇ nuevas porque incluye antiguos que volvieron a escribir.
  const nuevasConversaciones = convRows.reduce(
    (s, r) => s + Number(r.n || 0),
    0,
  );
  const totalConversaciones = Math.max(
    Number(activeConvRows?.[0]?.n || 0),
    nuevasConversaciones,
  );
  const totalMensajes = msgRows.reduce((s, r) => s + Number(r.n || 0), 0);

  // ── Clasificador de canal ──
  // Si la tienda tiene órdenes reales del webhook Shopify en la ventana,
  // una orden Dropi solo cuenta como Shopify si hace match con una de
  // ellas (teléfono + total ±0.5 + ventana 72h). Sin datos del webhook,
  // se usa el shop_type de Dropi tal cual (tiendas sin webhook activo).
  const phone9 = (p) =>
    String(p || '')
      .replace(/\D/g, '')
      .slice(-9);
  const shopifyTruthMap = new Map(); // phone9 → [{total, t}]
  for (const s of shopifyOrdRows || []) {
    const k = phone9(s.phone_normalizado);
    if (!k) continue;
    if (!shopifyTruthMap.has(k)) shopifyTruthMap.set(k, []);
    const ts = s.shopify_created_at || s.created_at;
    shopifyTruthMap.get(k).push({
      total: Number(s.total_price || 0),
      t: ts ? new Date(ts).getTime() : null,
    });
  }
  const hasShopifyTruth =
    VALIDAR_SHOPIFY_CON_WEBHOOK && (shopifyOrdRows || []).length > 0;
  const SHOPIFY_MATCH_WINDOW_MS = 72 * 3600 * 1000;
  const esOrdenShopify = (o) => {
    if (!hasShopifyTruth) return o.shop_type === 'SHOPIFY';
    const list = shopifyTruthMap.get(phone9(o.phone));
    if (!list) return false;
    const total = Number(o.total_order || 0);
    const t = o.order_created_at
      ? new Date(o.order_created_at).getTime()
      : null;
    return list.some(
      (s) =>
        Math.abs(s.total - total) < 0.5 &&
        (t == null ||
          s.t == null ||
          Math.abs(s.t - t) <= SHOPIFY_MATCH_WINDOW_MS),
    );
  };

  // ── Totales por canal (clasificación por shop_type) ──
  const blankCanal = () => ({
    pedidos: 0,
    facturado: 0,
    ganancia: 0,
    entregadas: 0,
    confirmados: 0,
    bot: 0,
  });
  const canales = { wa: blankCanal(), shopify: blankCanal() };
  let totalFacturado = 0,
    totalGanancia = 0;
  const statusMap = {};
  const shopifyPorDia = new Map(); // dia → n pedidos shopify (validados)

  for (const o of orderRows) {
    const total = Number(o.total_order || 0);
    const profit =
      o.dropshipper_profit != null ? Number(o.dropshipper_profit) : 0;
    const cat = o.classified_status || 'otro';
    const rawStatus = String(o.status || '').toUpperCase();
    const esShopify = esOrdenShopify(o);
    const C = canales[esShopify ? 'shopify' : 'wa'];

    if (esShopify && o.dia) {
      shopifyPorDia.set(o.dia, (shopifyPorDia.get(o.dia) || 0) + 1);
    }

    totalFacturado += total;
    totalGanancia += profit;
    C.pedidos += 1;
    C.facturado += total;
    C.ganancia += profit;
    if (cat === 'entregada') C.entregadas += 1;
    if (rawStatus !== 'PENDIENTE CONFIRMACION') C.confirmados += 1;
    if (botOrderIds.has(String(o.dropi_order_id))) C.bot += 1;

    if (!statusMap[cat]) statusMap[cat] = { status: cat, count: 0, total: 0 };
    statusMap[cat].count += 1;
    statusMap[cat].total += total;
  }

  // ── Serie diaria (todas las fechas en 'YYYY-MM-DD') ──
  const dayMap = {};
  const ensureDay = (dia) => {
    if (!dayMap[dia])
      dayMap[dia] = {
        day: dia,
        pedidos: 0,
        pedidos_wa: 0,
        pedidos_shopify: 0,
        facturado: 0,
        ganancia: 0,
        entregadas: 0,
        mensajes: msgByDay.get(dia) || 0,
        conversaciones: convByDay.get(dia) || 0,
      };
    return dayMap[dia];
  };
  for (const r of dailyRows) {
    const d = ensureDay(String(r.dia));
    d.pedidos = Number(r.pedidos || 0);
    // Split por canal con el clasificador validado (no el shop_type crudo)
    d.pedidos_shopify = shopifyPorDia.get(String(r.dia)) || 0;
    d.pedidos_wa = Math.max(0, d.pedidos - d.pedidos_shopify);
    d.facturado = r2(r.facturado);
    d.ganancia = r2(r.ganancia);
    d.entregadas = Number(r.entregadas || 0);
  }
  for (const dia of msgByDay.keys()) ensureDay(dia);
  for (const dia of convByDay.keys()) ensureDay(dia);
  const dailyChart = Object.values(dayMap).sort((a, b) =>
    a.day.localeCompare(b.day),
  );

  const totalPedidos = orderRows.length;
  const entregadas = statusMap.entregada?.count || 0;

  const buildCanal = (key, pctConf) => {
    const c = canales[key];
    return {
      pedidos: c.pedidos,
      facturado: r2(c.facturado),
      ganancia: r2(c.ganancia),
      entregadas: c.entregadas,
      confirmados: c.confirmados,
      bot: c.bot,
      tasaEntrega: c.pedidos > 0 ? r2((c.entregadas / c.pedidos) * 100) : 0,
      pctConfirmacion: pctConf,
    };
  };
  const pctConfWa =
    totalConversaciones > 0
      ? r2((canales.wa.pedidos / totalConversaciones) * 100)
      : 0;
  const pctConfShopify =
    canales.shopify.pedidos > 0
      ? r2((canales.shopify.confirmados / canales.shopify.pedidos) * 100)
      : 0;

  const carrito = carritoRows?.[0] || {};
  const abandonados = Number(carrito.abandonados || 0);
  const recuperados = Number(carrito.recuperados || 0);

  const productos = (prodRows || [])
    .map((r) => {
      const ventaEnt = Number(r.venta_entregadas || 0),
        costoEnt = Number(r.costo_entregadas || 0);
      const fleteMov = Number(r.flete_movilizadas || 0),
        entregadasP = Number(r.ordenes_entregadas || 0);
      const movilizadas = Number(r.movilizadas || 0),
        rent = ventaEnt - costoEnt - fleteMov;
      return {
        product_id: Number(r.product_id || 0),
        sku: r.sku || '',
        name: r.product_name || '(sin nombre)',
        image: r.image || null,
        ordenes: Number(r.ordenes || 0),
        confirmadas: Number(r.ordenes_confirmadas || 0),
        unidades: Number(r.unidades || 0),
        entregadas: entregadasP,
        devoluciones: Number(r.devoluciones || 0),
        canceladas: Number(r.canceladas || 0),
        transito: Number(r.transito || 0),
        tasaEntrega:
          movilizadas > 0 ? r2((entregadasP / movilizadas) * 100) : null,
        ingresoBruto: r2(ventaEnt),
        costo: r2(costoEnt),
        flete: r2(fleteMov),
        gananciaNeta: r2(rent),
        margenPct: ventaEnt > 0 ? r2((rent / ventaEnt) * 100) : null,
        ticketPromedio: entregadasP > 0 ? r2(ventaEnt / entregadasP) : 0,
      };
    })
    .sort((a, b) => b.gananciaNeta - a.gananciaNeta);

  // Conversaciones por producto (sin conteo de mensajes) + por canal
  const [ctwaActivo, convPorCanal] = await Promise.all([
    attachProductConversations({
      id_configuracion,
      orderRows,
      productos,
      from: fromDt,
      until: untilDt,
      hasShopifyTruth,
      clientByKey,
      adRows: ctwaAdRows,
    }),
    countCanalConversaciones({
      id_configuracion,
      orderRows,
      esOrdenShopify,
      clientByKey,
    }),
  ]);

  return res.json({
    isSuccess: true,
    data: {
      totalFacturado: r2(totalFacturado),
      totalGanancia: r2(totalGanancia),
      totalPedidos,
      entregadas,
      totalConversaciones,
      totalMensajes,
      pctConfirmacion:
        totalConversaciones > 0
          ? r2((totalPedidos / totalConversaciones) * 100)
          : 0,
      tasaEntrega: totalPedidos > 0 ? r2((entregadas / totalPedidos) * 100) : 0,
      canales: {
        wa: { ...buildCanal('wa', pctConfWa), conversaciones: convPorCanal.wa },
        shopify: {
          ...buildCanal('shopify', pctConfShopify),
          conversaciones: convPorCanal.shopify,
        },
      },
      carritos: {
        abandonados,
        recuperados,
        tasaRecuperacion:
          abandonados > 0 ? r2((recuperados / abandonados) * 100) : 0,
        valorRecuperado: r2(carrito.valor_recuperado),
      },
      dailyChart,
      statusBreakdown: Object.values(statusMap)
        .map((s) => ({
          ...s,
          total: r2(s.total),
          pct: totalPedidos > 0 ? r2((s.count / totalPedidos) * 100) : 0,
        }))
        .sort((a, b) => b.count - a.count),
      productos,
      // true → hubo conversaciones desde anuncios CTWA en el periodo;
      // false → el front no muestra conv. totales/% conf. por producto
      ctwaActivo,
      metaAds: {
        conectado: !!metaAdsRows?.length,
        accountName: metaAdsRows?.[0]?.ad_account_name || null,
      },
      // true → el split WA/Shopify está validado contra el webhook real
      shopifyTruth: hasShopifyTruth,
    },
  });
});

// ── Helpers exportados para uso interno (marketing_control) ──
exports._internal = {
  syncFromDropi,
  getActiveIntegration,
  getIntegrationKey,
  buildCacheKey,
  buildCacheWhere,
  attachProductConversations,
  fetchClientPhoneMap,
  computeStatsFromCache,
};
