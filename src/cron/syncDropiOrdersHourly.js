'use strict';

/**
 * cron/syncDropiOrdersHourly.js  — v8
 *
 * NUEVO EN v8:
 *  La lógica de clasificación de estados, upsert al cache y envío de
 *  templates se extrajo a services/dropi_notifier.service.js para
 *  compartirla con el webhook de Dropi (tiempo real). Este cron queda como
 *  RED DE SEGURIDAD: cubre las órdenes que el webhook no notifica (Dropi
 *  solo envía webhooks de órdenes creadas vía API con shop IMPORSUIT) y
 *  corrige cualquier evento perdido. Comportamiento de envío idéntico a v7.
 *
 *  Además: aprende dropi_user_id por integración (cuenta Dropi dueña de la
 *  key). Si todas las órdenes del lote pertenecen al mismo user_id, ese es
 *  el dueño (dropshipper). Los proveedores ven órdenes de muchos users y
 *  quedan NULL. El webhook usa esta columna para mapear eventos de órdenes
 *  nuevas que aún no están en el cache.
 *
 * NUEVO EN v7:
 *  Teléfonos multipaís vía libphonenumber (ver dropi_notifier.service).
 *
 * NUEVO EN v6:
 *  Fase 4: Profit Sync — rellena `dropshipper_profit` para órdenes
 *  recientes sin profit. Necesario porque el listado masivo de Dropi
 *  NO devuelve este campo (solo viene en getOrderDetail por orden).
 *  Sin esto, CAPI manda value=0 a Meta.
 */

const cron = require('node-cron');
const { Op } = require('sequelize');

const { db } = require('../database/config');
const DropiOrdersCache = require('../models/dropi_orders_cache.model');
const dropiService = require('../services/dropi.service');
const { decryptToken } = require('../utils/cryptoToken');
const {
  upsertOrders,
  procesarTemplates,
} = require('../services/dropi_notifier.service');

/* ═══════════════════════════════════════════════════════════
   Constantes
   ═══════════════════════════════════════════════════════════ */

const PAGE_SIZE = 100;
const DELAY_BETWEEN_PAGES = 2500;
const DELAY_BETWEEN_INTEGRATIONS = 4000;
const MAX_ORDERS_PER_INTEGRATION = 2000;
const MAX_RETRIES_429 = 4;

// Profit sync — Dropi solo expone profit vía getOrderDetail individual
const PROFIT_MAX_PER_RUN = 30;
const PROFIT_DELAY_MS = 2500;
const PROFIT_LOOKBACK_HOURS = 48;

/* ═══════════════════════════════════════════════════════════
   Helpers
   ═══════════════════════════════════════════════════════════ */

function getDateRange() {
  const now = new Date();
  const ecNow = new Date(
    now.getTime() + (now.getTimezoneOffset() + -5 * 60) * 60000,
  );
  const pad = (n) => String(n).padStart(2, '0');
  const fmt = (d) =>
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  return {
    from: fmt(new Date(ecNow.getTime() - 24 * 60 * 60 * 1000)),
    until: fmt(ecNow),
  };
}

/* ═══════════════════════════════════════════════════════════
   dropi_user_id — aprender la cuenta Dropi dueña de la integración
   ═══════════════════════════════════════════════════════════ */

async function aprenderDropiUserId(integration, allOrders) {
  if (integration.dropi_user_id || !allOrders.length) return;
  const userIds = new Set(
    allOrders.map((o) => o?.user_id).filter((v) => Number(v) > 0),
  );
  // Un único user_id en todo el lote → la key pertenece a ese dropshipper.
  // Varios user_ids → cuenta proveedor: se deja NULL (el cron la cubre).
  if (userIds.size !== 1) return;
  const uid = Number([...userIds][0]);
  try {
    await db.query(
      `UPDATE dropi_integrations SET dropi_user_id = ? WHERE id = ? AND dropi_user_id IS NULL`,
      { replacements: [uid, integration.id], type: db.QueryTypes.UPDATE },
    );
  } catch (err) {
    // best-effort: si falla, se reintenta en la próxima corrida
  }
}

/* ═══════════════════════════════════════════════════════════
   PROFIT SYNC (v6)
   Dropi NO devuelve dropshipper_profit en el listado.
   Lo trae solo en getOrderDetail bajo el campo dropshipper_amount_to_win.
   Acá rellenamos órdenes recientes con profit=null para que CAPI
   tenga value real al enviar Purchase a Meta.
   ═══════════════════════════════════════════════════════════ */

async function syncProfitForRecentOrders({
  integrationKey,
  country_code,
  cacheCtx,
}) {
  const cacheWhere = cacheCtx.id_configuracion
    ? { id_configuracion: cacheCtx.id_configuracion, id_usuario: 0 }
    : { id_configuracion: 0, id_usuario: cacheCtx.id_usuario };

  const sinceDate = new Date(Date.now() - PROFIT_LOOKBACK_HOURS * 3600 * 1000);

  const pending = await DropiOrdersCache.findAll({
    where: {
      ...cacheWhere,
      dropshipper_profit: null,
      order_created_at: { [Op.gte]: sinceDate },
    },
    attributes: ['id', 'dropi_order_id'],
    order: [['order_created_at', 'DESC']],
    limit: PROFIT_MAX_PER_RUN,
    raw: true,
  });

  if (!pending.length) return { calculated: 0, total: 0, isProveedor: false };

  let calculated = 0;
  let errors = 0;
  let isProveedor = false;

  for (let idx = 0; idx < pending.length; idx++) {
    const order = pending[idx];
    try {
      const detail = await dropiService.getOrderDetail({
        integrationKey,
        orderId: order.dropi_order_id,
        country_code,
      });

      const profit = detail?.objects?.dropshipper_amount_to_win;

      // Caso proveedor: primera orden sin profit → marca TODAS en 0 y corta.
      // Evita gastar API en cuentas donde no hay profit por diseño.
      if (idx === 0 && (profit === null || profit === undefined)) {
        await DropiOrdersCache.update(
          { dropshipper_profit: 0 },
          { where: { ...cacheWhere, dropshipper_profit: null } },
        );
        isProveedor = true;
        break;
      }

      await DropiOrdersCache.update(
        { dropshipper_profit: Number(profit || 0) },
        { where: { id: order.id } },
      );
      calculated++;

      await new Promise((r) => setTimeout(r, PROFIT_DELAY_MS));
    } catch (err) {
      const status = err?.response?.status || err?.statusCode || 500;
      if (status === 429) break;
      errors++;
      if (errors >= 5) break;
      await new Promise((r) => setTimeout(r, 3000));
    }
  }

  return { calculated, errors, total: pending.length, isProveedor };
}

/* ═══════════════════════════════════════════════════════════
   Sync de una integración
   ═══════════════════════════════════════════════════════════ */

async function syncIntegration(integration, from, until) {
  const label = `integ#${integration.id}(${integration.country_code})`;
  const id_config = integration.id_configuracion
    ? Number(integration.id_configuracion)
    : null;

  let integrationKey;
  try {
    integrationKey = decryptToken(integration.integration_key_enc);
  } catch (e) {
    return { label, synced: 0, skipped: true };
  }
  if (!integrationKey?.trim()) return { label, synced: 0, skipped: true };

  const cacheInsertFields = id_config
    ? { id_configuracion: id_config, id_usuario: 0 }
    : { id_configuracion: 0, id_usuario: Number(integration.id_usuario) };

  const cacheCtx = id_config
    ? { id_configuracion: id_config }
    : { id_usuario: Number(integration.id_usuario) };

  // Fase 1: Fetch Dropi
  let allOrders = [],
    start = 0,
    keepGoing = true,
    retries = 0,
    delay = DELAY_BETWEEN_PAGES;

  while (keepGoing) {
    try {
      const resp = await dropiService.listMyOrders({
        integrationKey,
        params: {
          result_number: PAGE_SIZE,
          start,
          filter_date_by: 'FECHA DE CAMBIO DE ESTATUS',
          from,
          until,
        },
        country_code: integration.country_code,
      });
      const objects = resp?.objects || [];
      allOrders = allOrders.concat(objects);
      keepGoing = objects.length >= PAGE_SIZE;
      start += PAGE_SIZE;
      retries = 0;
      delay = DELAY_BETWEEN_PAGES;
      if (allOrders.length >= MAX_ORDERS_PER_INTEGRATION) break;
      if (keepGoing) await new Promise((r) => setTimeout(r, delay));
    } catch (err) {
      const status = err?.statusCode || err?.status || 500;
      if (status === 429) {
        if (++retries >= MAX_RETRIES_429) break;
        delay = Math.min(delay * 2, 20000);
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      break;
    }
  }

  // Fase 2: Upsert cache + aprender dropi_user_id (para el webhook)
  if (allOrders.length > 0) {
    await upsertOrders(cacheInsertFields, allOrders);
    await aprenderDropiUserId(integration, allOrders);
  }

  // Fase 3: Templates + ENTREGADA pre-pass
  let templateStats = {
    enviados: 0,
    omitidos: 0,
    errores: 0,
    entregadas_actualizadas: 0,
  };
  if (id_config && allOrders.length > 0) {
    templateStats = await procesarTemplates({
      orders: allOrders,
      id_configuracion: id_config,
      country_code: integration.country_code,
    });
  }

  // ═══════════════════════════════════════════════════════════
  // Fase 4: Profit sync (v6)
  // Rellena dropshipper_profit para órdenes recientes con null.
  // Es safe-fail — si Dropi devuelve null/429/error, el cron sigue.
  // ═══════════════════════════════════════════════════════════
  let profitStats = { calculated: 0, total: 0, isProveedor: false };
  if (allOrders.length > 0) {
    try {
      profitStats = await syncProfitForRecentOrders({
        integrationKey,
        country_code: integration.country_code,
        cacheCtx,
      });
    } catch (err) {
      // log silencioso, no rompe sync principal
    }
  }

  return {
    label,
    synced: allOrders.length,
    skipped: false,
    templates: templateStats,
    profit: profitStats,
  };
}

/* ═══════════════════════════════════════════════════════════
   Job principal — con MySQL GET_LOCK
   ═══════════════════════════════════════════════════════════ */

async function runHourlyDropiSync() {
  const [row] = await db.query(
    `SELECT GET_LOCK('dropi_sync_hourly', 1) AS got`,
    { type: db.QueryTypes.SELECT },
  );
  if (!row || Number(row.got) !== 1) return;

  try {
    const { from, until } = getDateRange();

    // Solo integraciones activas + configs no suspendidas
    const integrations = await db.query(
      `SELECT di.id, di.id_configuracion, di.id_usuario, di.country_code,
              di.integration_key_enc, di.dropi_user_id
       FROM dropi_integrations di
       LEFT JOIN configuraciones c ON c.id = di.id_configuracion
       WHERE di.is_active = 1
         AND di.deleted_at IS NULL
         AND (
           di.id_configuracion IS NULL
           OR di.id_configuracion = 0
           OR (c.id IS NOT NULL AND COALESCE(c.suspendido, 0) = 0)
         )`,
      { type: db.QueryTypes.SELECT },
    );

    const totals = {
      ordenes: 0,
      enviados: 0,
      skipped: 0,
      errores: 0,
      entregadas: 0,
      profit_calculated: 0,
    };

    for (let i = 0; i < integrations.length; i++) {
      try {
        const r = await syncIntegration(integrations[i], from, until);
        if (r.skipped) {
          totals.skipped++;
        } else {
          totals.ordenes += r.synced;
          totals.enviados += r.templates?.enviados || 0;
          totals.errores += r.templates?.errores || 0;
          totals.entregadas += r.templates?.entregadas_actualizadas || 0;
          totals.profit_calculated += r.profit?.calculated || 0;
        }
      } catch (err) {
        totals.errores++;
      }
      if (i < integrations.length - 1)
        await new Promise((r) => setTimeout(r, DELAY_BETWEEN_INTEGRATIONS));
    }
  } catch (err) {
    // error general silencioso
  } finally {
    try {
      await db.query(`DO RELEASE_LOCK('dropi_sync_hourly')`, {
        type: db.QueryTypes.RAW,
      });
    } catch (e) {}
  }
}

const CRONS_ENABLED = process.env.NODE_ENV === 'production';

// v8: */15 (antes */5). El webhook de Dropi ya notifica en tiempo real las
// órdenes IMPORSUIT; este cron queda como red de seguridad para el resto
// (Shopify/bots/creadas en Dropi) y para eventos de webhook perdidos.
// Con 305 integraciones un ciclo completo toma ~20 min de todas formas, así
// que el impacto en frescura es mínimo y se reduce ~66% la presión de 429.
if (CRONS_ENABLED) {
  cron.schedule('*/15 * * * *', () => {
    runHourlyDropiSync().catch(() => {});
  });
  // console.log('[Cron Dropi] Activo (*/15 min)');
} else {
  console.log('[Cron Dropi] Deshabilitado — entorno no productivo');
}

module.exports = { runHourlyDropiSync };
