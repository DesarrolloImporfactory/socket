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

// =========================
// ✅ Exportable para Socket y Controller
// =========================
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

module.exports = { listOrdersForClient };
