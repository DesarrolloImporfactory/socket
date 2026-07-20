const AppError = require('../utils/appError');
const { decryptToken } = require('../utils/cryptoToken');
//  Normalización de teléfonos con libphonenumber (multipaís).
// toDropiLocal(phone, country_code) → número nacional sin código de país ni 0.
const {
  toDropiLocal,
  resolveRegion,
  toWhatsapp,
  isValidPhone,
} = require('../utils/phoneFactor');

const DropiIntegrations = require('../models/dropi_integrations.model');
const DropiOrdersCache = require('../models/dropi_orders_cache.model');
const ClientesChatCenter = require('../models/clientes_chat_center.model');
const Sub_usuarios_chat_center = require('../models/sub_usuarios_chat_center.model');
const { Op } = require('sequelize');

const dropiService = require('./dropi.service');
const { db } = require('../database/config');


// =========================
// País (texto) que Dropi espera en el payload de la orden, según el ISO de la
// integración. Lo derivamos del country_code para NO depender del front.
// 'Ecuador' (EC) es el valor PROBADO (es el que manda hoy el front y funciona).
//    Los demás son tentativos: confírmalos contra lo que acepta Dropi en cada
//    país ANTES de prenderlo (crea una orden de prueba y mira qué guarda/acepta).
// =========================
const COUNTRY_NAME_BY_ISO = {
  EC: 'Ecuador',
  MX: 'Mexico',
  CO: 'Colombia',
  PE: 'Peru',
  CL: 'Chile',
  GT: 'Guatemala',
  PA: 'Panama',
};

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

async function bloquearPlantillaPendienteConf({
  id_configuracion,
  dropi_order_id,
  phone,
  country_code = 'EC',
}) {
  if (!id_configuracion || !dropi_order_id) return false;
  try {
    const phoneNorm = toWhatsapp(phone, country_code) || strOrNull(phone);
    await db.query(
      `INSERT IGNORE INTO dropi_plantillas_enviadas
         (dropi_order_id, id_configuracion, estado_dropi, phone, template_name, source, sent_at)
       VALUES (?, ?, 'PENDIENTE CONFIRMACION', ?, '[SKIP] creada en sistema', 'sistema_local', NOW())`,
      {
        replacements: [dropi_order_id, id_configuracion, phoneNorm],
        type: db.QueryTypes.INSERT,
      },
    );
    return true;
  } catch (e) {
    console.log('[Dropi] error registrando bloqueo plantilla:', e?.message);
    return false;
  }
}

/**
 * @param {object} body   payload de la orden
 * @param {string} region country_code de la integración ("593", "EC", "57"...).
 *                        Se usa para normalizar el teléfono al local del país.
 */
function buildDropiCreateOrderPayload(body = {}, region = 'EC') {
  // ====== básicos ======
  const type = strOrNull(body.type) || 'FINAL_ORDER';
  const type_service = strOrNull(body.type_service) || 'normal';
  const rate_type = strOrNull(body.rate_type) || 'CON RECAUDO';

  const total_order = Number(body.total_order || 0);
  const shipping_amount = Number(body.shipping_amount || 0);
  const payment_method_id = toInt(body.payment_method_id) ?? 1;

  const notes = strOrNull(body.notes) || '';

  const status = strOrNull(body.status); // 'PENDIENTE CONFIRMACION' para órdenes del sistema

  const name = strOrNull(body.name);
  const surname = strOrNull(body.surname);
  //  FIX teléfono: Dropi guarda en LOCAL y recorta el campo a ~10 chars sin
  // quitar el código de país. Mandamos el nacional según el país de la
  const phone = toDropiLocal(body.phone, region);
  const client_email = strOrNull(body.client_email) || '';

  //  País derivado de la integración (fuente de verdad). Se ignora body.country
  // a propósito: así no hay que tocar el front al abrir nuevos países. Si el ISO
  // no está en el mapa, cae a lo que mande el front y, en último caso, Ecuador.
  const regionIso = resolveRegion(region);
  const country =
    COUNTRY_NAME_BY_ISO[regionIso] || strOrNull(body.country) || 'Ecuador';
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
    ...(status ? { status } : {}),

    total_order,
    shipping_amount,
    payment_method_id,

    notes,

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
 * Usa los últimos 9/10 dígitos, así que es agnóstico al código de país.
 */
function phoneKeys(v) {
  const d = digitsOnly(v);
  if (!d) return [];
  const keys = [];
  if (d.length >= 9) keys.push(d.slice(-9));
  if (d.length >= 10) keys.push(d.slice(-10));
  return Array.from(new Set(keys));
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
    orConditions.push({ celular_cliente: { [Op.like]: `%${k}` } });
  }

  const clientes = await ClientesChatCenter.findAll({
    where: { id_configuracion, deleted_at: null, [Op.or]: orConditions },
    attributes: ['id', 'celular_cliente', 'id_encargado', 'estado_contacto'],
    raw: true,
  });

  const clientByKey = new Map();
  for (const c of clientes) {
    [...phoneKeys(c?.celular_cliente)].forEach((k) => {
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

  // ✅ Leemos del cache local (dropi_orders_cache), ya sincronizado. Antes esto
  // pegaba en vivo a GET /orders/myorders con textToSearch, lo que devolvía
  // vacío (sin rango de fechas) y encima disparaba 429. El cache guarda el JSON
  // crudo de la orden en order_data, así que reconstruimos los mismos objetos
  // que el socket devolvía y los enriquecemos igual con chat/agente.
  const keys = phoneKeys(phone); // últimos 9/10 dígitos (agnóstico al país)
  if (!keys.length) {
    throw new AppError('Teléfono inválido para buscar órdenes', 400);
  }

  const resultNumber = toIntOrDefault(body?.result_number, 20);
  const status = strOrNull(body?.status);

  const where = {
    id_configuracion: Number(id_configuracion),
    id_usuario: 0,
    [Op.or]: keys.map((k) => ({ phone: { [Op.like]: `%${k}%` } })),
  };
  // Por defecto NO mostrar las REEMPLAZADA (versión vieja de una orden editada;
  // Dropi tampoco las muestra). Solo aparecen si se pide ese status explícito.
  if (status) where.status = status;
  else where.status = { [Op.ne]: 'REEMPLAZADA' };

  const rows = await DropiOrdersCache.findAll({
    where,
    order: [['order_created_at', 'DESC']],
    limit: resultNumber,
    attributes: ['order_data'],
    raw: true,
  });

  const objects = rows
    .map((r) => {
      try {
        return JSON.parse(r.order_data);
      } catch {
        return null;
      }
    })
    .filter(Boolean);

  const enrichedObjects = await enrichOrdersWithChatAndAgent({
    id_configuracion,
    objects,
  });

  return { isSuccess: true, status: 200, objects: enrichedObjects };
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

  // ✅ Guard anti-teléfono-mocho: rechazamos ANTES de crear en Dropi si el
  // número no es válido/completo para el país. Evita órdenes con teléfono
  // truncado (que Dropi no puede entregar y ensucian la cuenta del cliente).
  if (!isValidPhone(body.phone, integration.country_code)) {
    throw new AppError(
      'El teléfono del cliente no es válido o está incompleto. Revísalo antes de crear la orden.',
      400,
    );
  }

  //  pasamos el country_code de la integración para normalizar el teléfono al país correcto
  const payload = buildDropiCreateOrderPayload(body, integration.country_code);

  console.log('[Dropi] phone que se envía →', payload.phone);

  const dropiResponse = await dropiService.createOrderMyOrders({
    integrationKey,
    payload,
    country_code: integration.country_code,
  });

  const norm = normalizeDropiResult(dropiResponse);

  if (!norm.ok) {
    // lanza error con el mensaje real de Dropi
    throw new AppError(norm.message, norm.status || 400);
  }

  const created =
    norm.data?.objects ?? norm.data?.order ?? norm.data?.data ?? norm.data;
  const nuevoOrderId = toInt(created?.id) ?? toInt(norm.data?.id);

  console.log(
    '[Dropi] orden creada → id:',
    nuevoOrderId,
    '| status:',
    created?.status,
  );

  // ── Verificación post-creación: ¿Dropi guardó el número completo? ──
  // El guard de arriba garantiza que NOSOTROS enviamos un teléfono válido,
  // pero la API de Dropi a veces lo guarda con un dígito menos. Comparamos
  // lo enviado contra lo que Dropi devolvió (o el detalle de la orden si el
  // create no trae phone) y avisamos al front para que el agente lo corrija
  // en Dropi de inmediato. Best-effort: nunca tumba la creación.
  let telefono_alterado = null;
  try {
    const soloDigitos = (v) => String(v ?? '').replace(/\D/g, '');
    const enviado = soloDigitos(payload.phone);
    let guardado = created?.phone != null ? soloDigitos(created.phone) : null;

    if (guardado === null && nuevoOrderId) {
      const detalle = await dropiService.getOrderDetail({
        integrationKey,
        orderId: nuevoOrderId,
        country_code: integration.country_code,
      });
      const objDet = detalle?.objects ?? detalle?.data ?? detalle;
      if (objDet?.phone != null) guardado = soloDigitos(objDet.phone);
    }

    if (enviado && guardado !== null && guardado !== enviado) {
      telefono_alterado = { enviado, guardado, orden: nuevoOrderId };
      console.log(
        `[Dropi] ⚠ Dropi alteró el teléfono en la orden ${nuevoOrderId}: enviado "${enviado}" → guardado "${guardado}"`,
      );
    }
  } catch (verifyErr) {
    console.log(
      '[Dropi] verificación de teléfono post-create falló:',
      verifyErr?.message,
    );
  }

  const creaComoPendienteConf =
    String(body.status || '')
      .trim()
      .toUpperCase() === 'PENDIENTE CONFIRMACION';

  if (nuevoOrderId && creaComoPendienteConf) {
    await bloquearPlantillaPendienteConf({
      id_configuracion,
      dropi_order_id: nuevoOrderId,
      phone: body.phone,
      country_code: integration.country_code,
    });
  } else if (!nuevoOrderId) {
    console.log(
      '[Dropi] ⚠ sin id en respuesta create:',
      JSON.stringify(norm.data)?.slice(0, 600),
    );
  }

  // devuelve la data limpia + el aviso de teléfono alterado (si aplica)
  if (telefono_alterado && norm.data && typeof norm.data === 'object') {
    norm.data.telefono_alterado = telefono_alterado;
  }
  return norm.data;
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

  // ✅ Guard anti-teléfono-mocho (mismo criterio que en create): si el update
  // trae phone, debe ser válido/completo para el país. Solo aplica cuando
  // viene el campo — los updates de solo status no se ven afectados.
  if (body?.phone !== undefined && !isValidPhone(body.phone, integration.country_code)) {
    throw new AppError(
      'El teléfono del cliente no es válido o está incompleto. Revísalo antes de actualizar la orden.',
      400,
    );
  }

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

    // transportadora (objeto { id, name }) — para fijar/cambiar al confirmar
    'distributionCompany',

    // status (para confirmar/cancelar)
    'status',
  ]);

  const payload = {};
  for (const [k, v] of Object.entries(body || {})) {
    if (!allowed.has(k)) continue;
    // distributionCompany: objeto { id, name }; solo si trae id válido.
    if (k === 'distributionCompany') {
      const dc = v || {};
      const id = Number(dc.id) || null;
      if (id) payload.distributionCompany = { id, name: dc.name || '' };
      continue;
    }
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
      // FIX: mismo criterio que al crear — local del país de la integración.
      payload[k] = toDropiLocal(v, integration.country_code);
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

  const dropiResponse = await dropiService.updateMyOrder({
    integrationKey,
    orderId: oid,
    payload,
    country_code: integration.country_code,
  });

  const norm = normalizeDropiResult(dropiResponse);
  if (!norm.ok) {
    throw new AppError(norm.message, norm.status || 400);
  }

  return norm.data;
}

module.exports = {
  listOrdersForClient,
  createOrderForClient,
  updateOrderForClient,
};
