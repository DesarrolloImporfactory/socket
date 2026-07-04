'use strict';

/**
 * services/dropi_webhook_processor.service.js
 *
 * Procesamiento EN TIEMPO REAL de los eventos del webhook de Dropi
 * (POST /api/v1/dropi_webhook/orders → dropi_webhook.controller.js).
 *
 * Dropi solo notifica órdenes creadas vía API con shop tipo IMPORSUIT
 * (~22% del volumen); el cron syncDropiOrdersHourly sigue corriendo como
 * red de seguridad para el resto y para eventos perdidos. Duplicados
 * imposibles: reclamarEnvio() en dropi_notifier.service es atómico.
 *
 * Flujo por evento:
 *  1. Resolver a qué integración(es) pertenece la orden:
 *       a. filas existentes en dropi_orders_cache (dropi_order_id) — cubre
 *          también configs proveedor que ven la orden.
 *       b. dropi_integrations.dropi_user_id = payload.shop.user_id — cubre
 *          órdenes NUEVAS aún no cacheadas (típico: PENDIENTE CONFIRMACION).
 *     Solo integraciones activas y configs no suspendidas (igual que cron).
 *  2. Armar la orden: base = order_data del cache (si existe) + overlay de
 *     los campos frescos del payload. orderdetails del payload si viene con
 *     datos (~89%), si no el del cache.
 *  3. Enriquecer 'contenido' con UN getOrderDetail SOLO si la plantilla del
 *     estado lo usa y seguimos sin orderdetails (pasa por el rate limiter
 *     global de dropi.service). guia_pdf NO necesita llamada: se reconstruye
 *     desde sticker+país+transportadora (ver dropi_notifier.service).
 *  4. Por cada entidad: upsert al cache + procesarTemplates (solo configs).
 *
 * Cola FIFO en memoria (concurrencia 1): los eventos llegan de a pocos
 * (~1000/día) y procesarTemplates ya espacia los envíos a Meta.
 */

const { db } = require('../database/config');
const dropiService = require('./dropi.service');
const { decryptToken } = require('../utils/cryptoToken');
const {
  upsertOrders,
  procesarTemplates,
  getPlantillasActivas,
  mapDropiStatusToEstadoConfig,
  safeJsonParse,
} = require('./dropi_notifier.service');

const MAX_QUEUE = 5000;

/* ═══════════════════════════════════════════════════════════
   Helpers
   ═══════════════════════════════════════════════════════════ */

/** "2024-10-02T21:32:10.000000Z" → "2024-10-02 21:32:10" (MySQL-safe). */
function normalizeDropiDate(value) {
  if (!value || typeof value !== 'string') return value || null;
  return value.replace('T', ' ').replace(/(\.\d+)?Z?$/, '');
}

/** ¿La plantilla activa de este estado usa la variable indicada? */
function plantillaUsaVariable(plantilla, varName) {
  const config = safeJsonParse(plantilla?.parametros_json, null);
  if (!config) return false;
  if (Array.isArray(config.body) && config.body.includes(varName)) return true;
  if (
    Array.isArray(config.buttons) &&
    config.buttons.some((b) => b?.variable === varName)
  )
    return true;
  return false;
}

/* ═══════════════════════════════════════════════════════════
   Resolución de integraciones (¿a qué cliente(s) pertenece la orden?)
   ═══════════════════════════════════════════════════════════ */

async function resolverIntegraciones(payload, cacheRows) {
  const uid = Number(payload?.shop?.user_id || 0);
  const cfgIds = [
    ...new Set(
      cacheRows
        .map((r) => Number(r.id_configuracion))
        .filter((v) => Number.isFinite(v) && v > 0),
    ),
  ];
  const usrIds = [
    ...new Set(
      cacheRows
        .filter((r) => !Number(r.id_configuracion))
        .map((r) => Number(r.id_usuario))
        .filter((v) => Number.isFinite(v) && v > 0),
    ),
  ];

  const conds = [];
  const repl = [];
  if (uid > 0) {
    conds.push('di.dropi_user_id = ?');
    repl.push(uid);
  }
  if (cfgIds.length) {
    conds.push(
      `di.id_configuracion IN (${cfgIds.map(() => '?').join(',')})`,
    );
    repl.push(...cfgIds);
  }
  if (usrIds.length) {
    conds.push(
      `(COALESCE(di.id_configuracion, 0) = 0 AND di.id_usuario IN (${usrIds
        .map(() => '?')
        .join(',')}))`,
    );
    repl.push(...usrIds);
  }
  if (!conds.length) return [];

  // Mismos filtros de elegibilidad que el cron: activa, no borrada y
  // config no suspendida.
  const rows = await db.query(
    `SELECT di.id, di.id_configuracion, di.id_usuario, di.country_code,
            di.integration_key_enc, di.dropi_user_id
     FROM dropi_integrations di
     LEFT JOIN configuraciones c ON c.id = di.id_configuracion
     WHERE di.is_active = 1
       AND di.deleted_at IS NULL
       AND (
         COALESCE(di.id_configuracion, 0) = 0
         OR (c.id IS NOT NULL AND COALESCE(c.suspendido, 0) = 0)
       )
       AND (${conds.join(' OR ')})`,
    { replacements: repl, type: db.QueryTypes.SELECT },
  );

  // Una config puede tener varias tiendas Dropi (varias keys): dedupe por
  // entidad, prefiriendo la integración cuya cuenta Dropi es la dueña de la
  // orden (dropi_user_id = shop.user_id) para que getOrderDetail funcione.
  const porEntidad = new Map();
  for (const r of rows) {
    const idConfig = Number(r.id_configuracion || 0);
    const key = idConfig ? `c${idConfig}` : `u${Number(r.id_usuario || 0)}`;
    const actual = porEntidad.get(key);
    if (!actual || (uid > 0 && Number(r.dropi_user_id) === uid)) {
      porEntidad.set(key, r);
    }
  }
  return [...porEntidad.values()];
}

/* ═══════════════════════════════════════════════════════════
   Armado de la orden (merge cache + payload del webhook)
   ═══════════════════════════════════════════════════════════ */

// Campos escalares que el webhook puede refrescar. Solo pisan el valor del
// cache cuando vienen con contenido (un PENDIENTE tardío sin guía no debe
// borrar la guía ya conocida).
const OVERLAY_FIELDS = [
  'name',
  'surname',
  'phone',
  'email',
  'dir',
  'country',
  'state',
  'city',
  'zip_code',
  'total_order',
  'rate_type',
  'shipping_company',
  'shipping_guide',
  'sticker',
  'shop_order_id',
  'shop_order_number',
  'external_id',
  'shop_id',
  'warehouse_id',
  'supplier_id',
  'type',
  'notes',
];

function buildOrderFromWebhook(payload, baseOrderData) {
  const order = baseOrderData ? { ...baseOrderData } : {};

  order.id = Number(payload.id);
  // El status del evento SIEMPRE manda (es la novedad que Dropi notifica)
  order.status = payload.status;

  for (const f of OVERLAY_FIELDS) {
    const v = payload[f];
    if (v !== null && v !== undefined && v !== '') order[f] = v;
  }

  if (payload.shop && typeof payload.shop === 'object') {
    order.shop = payload.shop;
    order.shop_id = payload.shop_id ?? payload.shop.id ?? order.shop_id;
  }

  if (Array.isArray(payload.orderdetails) && payload.orderdetails.length > 0) {
    order.orderdetails = payload.orderdetails;
  } else if (!Array.isArray(order.orderdetails)) {
    order.orderdetails = [];
  }

  // Fecha de creación original de la orden (no del evento)
  const createdAt =
    order.created_at || normalizeDropiDate(payload.created_at) || null;
  order.created_at = normalizeDropiDate(createdAt);

  return order;
}

/* ═══════════════════════════════════════════════════════════
   Enriquecimiento puntual vía getOrderDetail
   ═══════════════════════════════════════════════════════════ */

async function enriquecerConDetalle(order, integracion) {
  try {
    const integrationKey = decryptToken(integracion.integration_key_enc);
    if (!integrationKey?.trim()) return order;

    const detail = await dropiService.getOrderDetail({
      integrationKey,
      orderId: order.id,
      country_code: integracion.country_code,
    });

    const obj = detail?.objects;
    if (obj && typeof obj === 'object') {
      // El detalle es la fuente más rica: sirve de base y el evento del
      // webhook (status fresco + overlay) va encima.
      const merged = { ...obj, ...order };
      if (Array.isArray(obj.orderdetails) && obj.orderdetails.length > 0) {
        merged.orderdetails = obj.orderdetails;
      }
      if (obj.guia_urls3 && !merged.guia_urls3) {
        merged.guia_urls3 = obj.guia_urls3;
      }
      merged.created_at = normalizeDropiDate(
        merged.created_at || obj.created_at,
      );
      return merged;
    }
  } catch (err) {
    // Best-effort: sin detalle, la variable 'contenido' degrada a
    // 'Tu pedido' (mismo fallback histórico del cron).
    console.log(
      `[DropiWebhook RT] getOrderDetail falló para orden ${order.id}: ${err?.message || err}`,
    );
  }
  return order;
}

/* ═══════════════════════════════════════════════════════════
   Procesar UN evento
   ═══════════════════════════════════════════════════════════ */

async function processOne(payload) {
  const dropiOrderId = Number(payload?.id);
  if (!Number.isFinite(dropiOrderId) || dropiOrderId <= 0) return;
  if (!payload?.status) return;

  // 1) ¿Quién(es) conocen esta orden? (cache) — puede haber varias filas:
  //    dropshipper + proveedor
  const cacheRows = await db.query(
    `SELECT id_configuracion, id_usuario, order_data
     FROM dropi_orders_cache
     WHERE dropi_order_id = ?`,
    { replacements: [dropiOrderId], type: db.QueryTypes.SELECT },
  );

  // 2) Integraciones elegibles (cache + mapeo dropi_user_id)
  const integraciones = await resolverIntegraciones(payload, cacheRows);
  if (!integraciones.length) {
    // Orden de una cuenta Dropi no integrada en el sistema: se ignora
    // (el evento ya quedó persistido en dropi_webhook_events).
    return;
  }

  // 3) Base: el order_data más rico del cache (preferir uno con productos)
  let base = null;
  for (const row of cacheRows) {
    const parsed = safeJsonParse(row.order_data, null);
    if (!parsed) continue;
    if (!base) base = parsed;
    if (
      Array.isArray(parsed.orderdetails) &&
      parsed.orderdetails.length > 0 &&
      !(Array.isArray(base.orderdetails) && base.orderdetails.length > 0)
    ) {
      base = parsed;
    }
  }

  let order = buildOrderFromWebhook(payload, base);
  const estadoConfig = mapDropiStatusToEstadoConfig(order.status);

  // 4) Enriquecer 'contenido' SOLO si hace falta: sin productos y con alguna
  //    plantilla activa de este estado que use la variable. Una sola llamada
  //    a Dropi (pasa por el rate limiter global).
  const plantillasPorConfig = new Map();
  if (estadoConfig && order.orderdetails.length === 0) {
    let necesitaDetalle = false;
    for (const integ of integraciones) {
      const idConfig = Number(integ.id_configuracion || 0);
      if (!idConfig) continue;
      const plantillas = await getPlantillasActivas(idConfig);
      plantillasPorConfig.set(idConfig, plantillas);
      if (plantillaUsaVariable(plantillas[estadoConfig], 'contenido')) {
        necesitaDetalle = true;
      }
    }
    if (necesitaDetalle) {
      const uid = Number(payload?.shop?.user_id || 0);
      const duena =
        integraciones.find((i) => Number(i.dropi_user_id) === uid) ||
        integraciones[0];
      order = await enriquecerConDetalle(order, duena);
    }
  }

  // 5) Upsert cache + templates por entidad (mismo formato que el cron)
  let enviadosTotal = 0;
  for (const integ of integraciones) {
    const idConfig = Number(integ.id_configuracion || 0);
    const cacheInsertFields = idConfig
      ? { id_configuracion: idConfig, id_usuario: 0 }
      : { id_configuracion: 0, id_usuario: Number(integ.id_usuario) };

    try {
      await upsertOrders(cacheInsertFields, [order]);

      if (idConfig) {
        const stats = await procesarTemplates({
          orders: [order],
          id_configuracion: idConfig,
          country_code: integ.country_code,
        });
        enviadosTotal += stats?.enviados || 0;
      }
    } catch (err) {
      console.log(
        `[DropiWebhook RT] error en entidad ${idConfig || `u${integ.id_usuario}`} orden ${dropiOrderId}: ${err?.message || err}`,
      );
    }
  }

  if (enviadosTotal > 0) {
    console.log(
      `[DropiWebhook RT] orden ${dropiOrderId} "${order.status}" → ${enviadosTotal} mensaje(s) enviados en tiempo real`,
    );
  }
}

/* ═══════════════════════════════════════════════════════════
   Cola FIFO en memoria
   ═══════════════════════════════════════════════════════════ */

const queue = [];
let draining = false;

async function drain() {
  draining = true;
  while (queue.length > 0) {
    const payload = queue.shift();
    try {
      await processOne(payload);
    } catch (err) {
      console.log(
        `[DropiWebhook RT] error procesando evento ${payload?.id}: ${err?.message || err}`,
      );
    }
  }
  draining = false;
}

/**
 * Encola un evento del webhook para procesarlo en tiempo real.
 * Fire-and-forget: el controller responde 200 a Dropi sin esperar.
 */
function encolarEventoWebhook(payload) {
  if (queue.length >= MAX_QUEUE) {
    console.log(
      `[DropiWebhook RT] cola llena (${MAX_QUEUE}), evento ${payload?.id} descartado (el cron lo cubrirá)`,
    );
    return;
  }
  queue.push(payload);
  if (!draining) {
    drain().catch(() => {
      draining = false;
    });
  }
}

module.exports = {
  encolarEventoWebhook,
  // exportados para pruebas
  processOne,
  buildOrderFromWebhook,
  resolverIntegraciones,
  normalizeDropiDate,
};
