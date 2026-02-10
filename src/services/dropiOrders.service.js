const AppError = require('../utils/appError');
const { decryptToken } = require('../utils/cryptoToken');

const DropiIntegrations = require('../models/dropi_integrations.model');
const ClientesChatCenter = require('../models/clientes_chat_center.model');
const Sub_usuarios_chat_center = require('../models/sub_usuarios_chat_center.model');
const { Op } = require('sequelize');

const dropiService = require('./dropi.service');

// =========================
// Helpers
// =========================
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

function strOrNull(v) {
  if (v === null || v === undefined) return null;
  const s = String(v);
  return s.trim().length ? s.trim() : null;
}

function toIntOrDefault(v, def) {
  const n = toInt(v);
  return n === null ? def : n;
}

/**
 * Limpia params para NO enviar null/undefined/"" a Dropi
 * (algunas APIs interpretan "from=null" o "from=" y rompen filtros)
 */
function cleanParams(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj || {})) {
    if (v === undefined || v === null) continue;
    if (typeof v === 'string' && v.trim() === '') continue;
    out[k] = v;
  }
  return out;
}

function normalizeDropiResult(raw) {
  const dropi = raw?.data ?? raw ?? {};

  const status = Number(dropi?.status ?? 200);
  const ok = dropi?.isSuccess === true && status >= 200 && status < 300;

  const message =
    dropi?.message || (ok ? 'OK' : 'Error en Dropi') || 'Respuesta sin mensaje';

  return { ok, status, message, data: dropi };
}

function buildDropiOrdersListParams(body = {}) {
  const result_number = toIntOrDefault(body.result_number, 10);

  const filter_date_by = strOrNull(body.filter_date_by) || 'FECHA DE CREADO';
  const from = strOrNull(body.from);
  const until = strOrNull(body.until);
  const status = strOrNull(body.status);
  const textToSearch = strOrNull(body.textToSearch);

  if (!result_number || !filter_date_by) {
    throw new AppError(
      'filter_date_by y result_number son obligatorios para consultar órdenes',
      400,
    );
  }

  const params = {
    result_number,
    filter_date_by,
    from,
    until,
  };

  if (status) params.status = status;
  if (textToSearch) params.textToSearch = textToSearch;

  // ✅ importante: limpiar nulos antes de enviarlos
  return cleanParams(params);
}

function buildDropiCreateOrderPayload(body = {}) {
  // ====== básicos ======
  const type = strOrNull(body.type) || 'FINAL_ORDER';
  const type_service = strOrNull(body.type_service) || 'normal';
  const rate_type = strOrNull(body.rate_type) || 'CON RECAUDO';

  const total_order = Number(body.total_order || 0);
  const shipping_amount = Number(body.shipping_amount || 0);
  const payment_method_id = toInt(body.payment_method_id) ?? 1;

  const notes = strOrNull(body.notes) || '';

  // const supplier_id = toInt(body.supplier_id);
  // const shop_id = toInt(body.shop_id);
  // const warehouses_selected_id = toInt(body.warehouses_selected_id);

  const name = strOrNull(body.name);
  const surname = strOrNull(body.surname);
  const phone = digitsOnly(body.phone);
  const client_email = strOrNull(body.client_email) || '';

  const country = strOrNull(body.country) || 'ECUADOR';
  const state = strOrNull(body.state);
  const city = strOrNull(body.city);
  const dir = strOrNull(body.dir);
  const zip_code = body.zip_code ?? null;
  const colonia = strOrNull(body.colonia) || '';

  const dni = strOrNull(body.dni) || '';
  const dni_type = strOrNull(body.dni_type) || '';

  const insurance = body.insurance ?? null;
  const shalom_data = body.shalom_data ?? null;

  // ====== distributionCompany (OBLIGATORIO según su Postman) ======
  const dcId = toInt(
    body?.distributionCompany?.id ?? body?.distributionCompanyId,
  );
  const dcName = strOrNull(
    body?.distributionCompany?.name ?? body?.distributionCompanyName,
  );

  if (!dcId || !dcName) {
    throw new AppError('distributionCompany es requerido: { id, name }', 400);
  }

  // ====== products (OBLIGATORIO según su Postman) ======
  const productsRaw = Array.isArray(body.products) ? body.products : [];
  if (!productsRaw.length) throw new AppError('products es requerido', 400);

  const products = productsRaw.map((p) => {
    const id = toInt(p.id);
    const name = strOrNull(p.name) || 'Producto';
    const type = strOrNull(p.type) || 'SIMPLE';

    const quantity = Math.max(1, toInt(p.quantity) || 1);
    const price = Number(p.price || 0);

    // En Postman van como string (ej: "10500.00"), pero Dropi suele aceptar string/number.
    const sale_price = p.sale_price ?? null;
    const suggested_price = p.suggested_price ?? null;

    // Variaciones
    const variation_id = p.variation_id ?? null;
    const variations = Array.isArray(p.variations) ? p.variations : [];

    if (!id) throw new AppError('Producto inválido: id es requerido', 400);
    if (!price || price <= 0) {
      // en su ejemplo price = 50000, o sea el valor final a cobrar por ese ítem
      throw new AppError(
        `Producto inválido: price debe ser > 0 (id=${id})`,
        400,
      );
    }

    return {
      id,
      name,
      type,
      variation_id,
      variations,
      quantity,
      price,
      sale_price,
      suggested_price,
    };
  });

  // if (!supplier_id) throw new AppError('supplier_id es requerido', 400);
  // if (!shop_id) throw new AppError('shop_id es requerido', 400);
  // if (!warehouses_selected_id)
  //   throw new AppError('warehouses_selected_id es requerido', 400);

  if (!name) throw new AppError('name es requerido', 400);
  if (!surname) throw new AppError('surname es requerido', 400);
  if (!phone) throw new AppError('phone es requerido', 400);

  if (!state) throw new AppError('state es requerido', 400);
  if (!city) throw new AppError('city es requerido', 400);
  if (!dir) throw new AppError('dir es requerido', 400);

  if (!total_order || total_order <= 0)
    throw new AppError('total_order es requerido y debe ser > 0', 400);

  return {
    type,
    type_service,
    rate_type,

    total_order,
    shipping_amount,
    payment_method_id,

    notes,

    // supplier_id,
    // shop_id,
    // warehouses_selected_id,

    name,
    surname,
    phone,
    client_email,

    country,
    state,
    city,
    dir,
    zip_code,
    colonia,

    dni,
    dni_type,

    insurance,
    shalom_data,

    distributionCompany: { id: dcId, name: dcName },

    products,
  };
}

// =========================
// Phone helpers
// =========================
function digitsOnly(v) {
  return String(v || '').replace(/\D/g, '');
}

/**
 * Keys para match interno (clientes_chat_center) y para normalizar variaciones.
 */
function phoneKeys(v) {
  const d = digitsOnly(v);
  if (!d) return [];
  const keys = [];
  if (d.length >= 9) keys.push(d.slice(-9));
  if (d.length >= 10) keys.push(d.slice(-10));
  return Array.from(new Set(keys));
}

/**
 * ✅ Candidatos para buscar en Dropi (textToSearch)
 * Orden: 9 dígitos -> 10 dígitos -> completo (por si Dropi guarda con prefijo)
 */
function pickCandidatesPhoneSearch(phoneRaw) {
  const d = digitsOnly(phoneRaw);
  if (!d) return [];

  const c = [];
  if (d.length >= 9) c.push(d.slice(-9));
  if (d.length >= 10) c.push(d.slice(-10));
  c.push(d); // fallback: completo

  return Array.from(new Set(c));
}

// =========================
// Enriquecer órdenes (bulk, 1 query clientes + 1 query subusuarios)
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
      chat_id_cliente: null,
      chat_id_encargado: null,
    }));
  }

  const orConditions = [];
  for (const k of uniqueKeys) {
    orConditions.push(
      { celular_cliente: { [Op.like]: `%${k}` } },
      { telefono_limpio: { [Op.like]: `%${k}` } },
    );
  }

  const clientes = await ClientesChatCenter.findAll({
    where: { id_configuracion, deleted_at: null, [Op.or]: orConditions },
    attributes: [
      'id',
      'celular_cliente',
      'telefono_limpio',
      'id_encargado',
      'estado_contacto',
    ],
    raw: true,
  });

  const clientByKey = new Map();
  for (const c of clientes) {
    [
      ...phoneKeys(c?.celular_cliente),
      ...phoneKeys(c?.telefono_limpio),
    ].forEach((k) => {
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

  return objects.map((o) => {
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
}

async function listOrdersForClient({ id_configuracion, phone, body = {} }) {
  const integration = await getActiveIntegration(id_configuracion);
  if (!integration) {
    throw new AppError(
      'No existe una integración Dropi activa para esta configuración',
      404,
    );
  }

  const integrationKey = decryptToken(integration.integration_key_enc);
  if (!integrationKey || !String(integrationKey).trim()) {
    throw new AppError('Dropi key inválida o no disponible', 400);
  }

  // params base (limpios)
  const baseParams = buildDropiOrdersListParams(body);

  // ✅ probar candidatos del teléfono para que Dropi encuentre (9 / 10 / completo)
  const candidates = pickCandidatesPhoneSearch(phone);
  if (!candidates.length) {
    throw new AppError('Teléfono inválido para buscar en Dropi', 400);
  }

  let dropiResponse = null;
  let objects = [];

  for (const cand of candidates) {
    const params = cleanParams({
      ...baseParams,
      textToSearch: cand,
    });

    dropiResponse = await dropiService.listMyOrders({
      integrationKey,
      params,
    });

    objects = dropiResponse?.objects || dropiResponse?.data?.objects || [];
    if (Array.isArray(objects) && objects.length) break; // ✅ encontró: salimos
  }

  const enrichedObjects = await enrichOrdersWithChatAndAgent({
    id_configuracion,
    objects: Array.isArray(objects) ? objects : [],
  });

  return { ...(dropiResponse || {}), objects: enrichedObjects };
}

async function createOrderForClient({ id_configuracion, body = {} }) {
  const integration = await getActiveIntegration(id_configuracion);
  if (!integration) {
    throw new AppError(
      'No existe una integración Dropi activa para esta configuración',
      404,
    );
  }

  const integrationKey = decryptToken(integration.integration_key_enc);
  if (!integrationKey || !String(integrationKey).trim()) {
    throw new AppError('Dropi key inválida o no disponible', 400);
  }

  const payload = buildDropiCreateOrderPayload(body);

  const dropiResponse = await dropiService.createOrderMyOrders({
    integrationKey,
    payload,
  });

  const norm = normalizeDropiResult(dropiResponse);

  if (!norm.ok) {
    // lanza error con el mensaje real de Dropi
    throw new AppError(norm.message, norm.status || 400);
  }

  return norm.data; // devuelve solo la data limpia
}

/**
 * UPDATE (PUT) order in Dropi
 * orderId: number
 * body: allowed fields + status changes
 */
async function updateOrderForClient({ id_configuracion, orderId, body }) {
  const idCfg = toInt(id_configuracion);
  const oid = toInt(orderId);

  if (!idCfg) throw new AppError('id_configuracion es requerido', 400);
  if (!oid) throw new AppError('orderId es requerido', 400);

  const integration = await getActiveIntegration(idCfg);
  if (!integration)
    throw new AppError('No existe una integración Dropi activa', 404);

  const integrationKey = decryptToken(integration.integration_key_enc);
  if (!integrationKey) throw new AppError('Dropi key inválida', 400);

  //  Whitelist de campos editables (para no mandar basura)
  const allowed = new Set([
    'name',
    'surname',
    'phone',
    'client_email',
    'dir',
    'country',
    'state',
    'city',
    'colonia',
    'zip_code',
    'notes',
    'dni',
    'dni_type',

    // en su caso, si Dropi lo permite:
    'coordinates',
    'sticker',

    // status (para confirmar/cancelar)
    'status',
  ]);

  const payload = {};
  for (const [k, v] of Object.entries(body || {})) {
    if (!allowed.has(k)) continue;
    // normalización simple
    if (
      [
        'name',
        'surname',
        'dir',
        'country',
        'state',
        'city',
        'colonia',
        'notes',
        'dni',
        'dni_type',
        'client_email',
      ].includes(k)
    ) {
      const s = strOrNull(v);
      if (s !== null) payload[k] = s;
      continue;
    }
    if (k === 'zip_code') {
      payload[k] = v === null ? null : String(v);
      continue;
    }
    if (k === 'phone') {
      // Dropi le está devolviendo sin prefijo, ejemplo "962803007"
      // acá solo limpiamos caracteres
      payload[k] = String(v || '').replace(/\D/g, '');
      continue;
    }
    if (k === 'status') {
      payload[k] = String(v || '')
        .trim()
        .toUpperCase();
      continue;
    }
    payload[k] = v;
  }

  if (!Object.keys(payload).length) {
    throw new AppError('No hay campos válidos para actualizar', 400);
  }

  return dropiService.updateMyOrder({
    integrationKey,
    orderId: oid,
    payload,
  });
}

module.exports = {
  listOrdersForClient,
  createOrderForClient,
  updateOrderForClient,
};
