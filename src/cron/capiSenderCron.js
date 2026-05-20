/**
 * crons/capiSenderCron.js
 * Cron cada 5 min: envía órdenes 'pendiente' a Meta CAPI
 */

const { db } = require('../database/config');
const logger = require('../utils/logger');
const { sendPurchaseEvent } = require('../services/metaCapi.service');
const { getConfigFromDB } = require('../utils/whatsappTemplate.helpers');

const WINDOW_HOURS = 72;
const MAX_ATTEMPTS = 3;
const MAX_AGE_DAYS = 7; // Meta no acepta eventos > 7 días
const BATCH_LIMIT = 100;

let isRunning = false;

function normalizePhone(p) {
  let d = String(p || '').replace(/\D/g, '');
  if (d.startsWith('593')) d = d.slice(3);
  if (d.startsWith('0')) d = d.slice(1);
  return d.slice(-9);
}

/**
 * Encuentra el ad atribuido para cada orden usando teléfono + ventana 72h.
 * Misma lógica que el dashboard.
 */
async function findAdMatchesForOrders(idConfiguracion, orders) {
  if (!orders.length) return new Map();

  const windowMs = WINDOW_HOURS * 60 * 60 * 1000;
  const orderTimes = orders.map((o) => new Date(o.order_created_at).getTime());
  const sinceExt = new Date(Math.min(...orderTimes) - windowMs)
    .toISOString()
    .slice(0, 19)
    .replace('T', ' ');
  const untilExt = new Date(Math.max(...orderTimes))
    .toISOString()
    .slice(0, 19)
    .replace('T', ' ');

  const [msgRows] = await db.query(
    `SELECT cpa.source_id, cpa.ctwa_clid, cpa.headline,
            cpa.created_at AS msg_at,
            cc.celular_cliente, cc.telefono_limpio
     FROM cliente_productos_ad cpa
     INNER JOIN clientes_chat_center cc ON cc.id = cpa.id_cliente
     WHERE cpa.id_configuracion = :idCfg
       AND cpa.source_id IS NOT NULL AND cpa.source_id != ''
       AND cpa.created_at BETWEEN :since AND :until`,
    {
      replacements: {
        idCfg: idConfiguracion,
        since: sinceExt,
        until: untilExt,
      },
    },
  );

  const msgsByPhone = new Map();
  for (const msg of msgRows) {
    const key = normalizePhone(msg.telefono_limpio || msg.celular_cliente);
    if (!key) continue;
    if (!msgsByPhone.has(key)) msgsByPhone.set(key, []);
    msgsByPhone.get(key).push({
      source_id: String(msg.source_id),
      ctwa_clid: msg.ctwa_clid,
      headline: msg.headline,
      created_at: new Date(msg.msg_at),
    });
  }
  for (const arr of msgsByPhone.values()) {
    arr.sort((a, b) => b.created_at - a.created_at);
  }

  const matches = new Map();
  for (const order of orders) {
    const phoneKey = normalizePhone(order.phone);
    if (!phoneKey) continue;
    const candidates = msgsByPhone.get(phoneKey) || [];
    if (!candidates.length) continue;

    const orderTime = new Date(order.order_created_at);
    const windowStart = new Date(orderTime.getTime() - windowMs);
    const winner = candidates.find(
      (c) => c.created_at >= windowStart && c.created_at <= orderTime,
    );
    if (winner) {
      matches.set(order.dropi_order_id, {
        ad_id: winner.source_id,
        ctwa_clid: winner.ctwa_clid,
        headline: winner.headline,
      });
    }
  }

  return matches;
}

/**
 * Procesa una conexión Meta Ads: busca órdenes pendientes y envía a CAPI
 */
async function processConnection(connection) {
  const idCfg = connection.id_configuracion;

  // ★ NUEVO — Validar WABA_ID antes de procesar nada.
  // Meta exige whatsapp_business_account_id para action_source=business_messaging.
  // Sin WABA_ID, todos los eventos fallarán con error 100 / subcode 2804116.
  const wabaConfig = await getConfigFromDB(idCfg);
  if (!wabaConfig?.WABA_ID) {
    await db.query(
      `UPDATE meta_ad_connections
       SET capi_enabled = 0,
           capi_paused_reason = 'Falta WABA_ID (id_whatsapp) en configuraciones',
           capi_paused_at = NOW()
       WHERE id_configuracion = ?`,
      { replacements: [idCfg] },
    );
    logger.warn(`[CAPI] config ${idCfg}: WABA_ID faltante, conexión pausada`);
    return { connection: idCfg, processed: 0, sent: 0, no_match: 0, failed: 0 };
  }
  const wabaId = wabaConfig.WABA_ID;

  const cutoffDate = new Date(Date.now() - MAX_AGE_DAYS * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 19)
    .replace('T', ' ');

  const [orders] = await db.query(
    `SELECT dropi_order_id, phone, name, surname, classified_status,
            total_order, dropshipper_profit, order_created_at,
            capi_attempts
     FROM dropi_orders_cache
     WHERE id_configuracion = :idCfg
       AND classified_status = 'pendiente'
       AND capi_status = 'pending'
       AND capi_attempts < :maxAtt
       AND order_created_at >= :cutoff
     ORDER BY order_created_at ASC
     LIMIT :lim`,
    {
      replacements: {
        idCfg,
        maxAtt: MAX_ATTEMPTS,
        cutoff: cutoffDate,
        lim: BATCH_LIMIT,
      },
    },
  );

  const stats = {
    connection: idCfg,
    processed: 0,
    sent: 0,
    no_match: 0,
    failed: 0,
  };
  if (!orders.length) return stats;

  const matches = await findAdMatchesForOrders(idCfg, orders);

  for (const order of orders) {
    stats.processed++;
    const match = matches.get(order.dropi_order_id);

    // Sin match → marcar y no reintentar
    if (!match) {
      await db.query(
        `UPDATE dropi_orders_cache 
         SET capi_status = 'no_match',
             capi_attempts = capi_attempts + 1,
             capi_last_attempt_at = NOW(),
             capi_last_error = 'Sin match a anuncio (no vino de CTWA o fuera de ventana 72h)'
         WHERE dropi_order_id = ? AND id_configuracion = ?`,
        { replacements: [order.dropi_order_id, idCfg] },
      );
      stats.no_match++;
      continue;
    }

    // Hay match → enviar
    const eventId = `dropi_${order.dropi_order_id}_purchase`;
    const value = Number(order.dropshipper_profit || 0);

    const result = await sendPurchaseEvent({
      pixelId: connection.pixel_id,
      accessToken: connection.access_token,
      eventId,
      value,
      currency: connection.currency || 'USD',
      eventTime: order.order_created_at,
      orderId: order.dropi_order_id,
      adId: match.ad_id,
      user: {
        phone: order.phone,
        firstName: order.name,
        lastName: order.surname,
        ctwaClid: match.ctwa_clid,
        wabaId, // ★ NUEVO — inyecta whatsapp_business_account_id en user_data
      },
      testEventCode: connection.capi_test_event_code || null,
    });

    if (result.success) {
      await db.query(
        `UPDATE dropi_orders_cache 
         SET capi_status = 'sent',
             capi_event_id = ?,
             capi_ad_id = ?,
             capi_pixel_id = ?,
             capi_value = ?,
             capi_sent_at = NOW(),
             capi_response_code = ?,
             capi_response_body = ?,
             capi_attempts = capi_attempts + 1,
             capi_last_attempt_at = NOW(),
             capi_last_error = NULL
         WHERE dropi_order_id = ? AND id_configuracion = ?`,
        {
          replacements: [
            eventId,
            match.ad_id,
            connection.pixel_id,
            value,
            result.statusCode,
            JSON.stringify(result.response || {}).slice(0, 2000),
            order.dropi_order_id,
            idCfg,
          ],
        },
      );
      stats.sent++;
    } else {
      const isAuthError = [190, 102].includes(result.errorCode);
      const newAttempts = (Number(order.capi_attempts) || 0) + 1;
      const finalStatus = newAttempts >= MAX_ATTEMPTS ? 'failed' : 'pending';

      await db.query(
        `UPDATE dropi_orders_cache 
         SET capi_status = ?,
             capi_attempts = ?,
             capi_last_attempt_at = NOW(),
             capi_response_code = ?,
             capi_response_body = ?,
             capi_last_error = ?
         WHERE dropi_order_id = ? AND id_configuracion = ?`,
        {
          replacements: [
            finalStatus,
            newAttempts,
            result.statusCode,
            JSON.stringify(result.response || {}).slice(0, 2000),
            result.errorMessage || 'Error desconocido',
            order.dropi_order_id,
            idCfg,
          ],
        },
      );

      // Error de auth → pausar conexión completa
      if (isAuthError) {
        await db.query(
          `UPDATE meta_ad_connections 
           SET capi_enabled = 0,
               capi_paused_reason = ?,
               capi_paused_at = NOW()
           WHERE id_configuracion = ?`,
          {
            replacements: [
              `Token expirado o sin permisos (error ${result.errorCode}). Reconectar Meta Ads.`,
              idCfg,
            ],
          },
        );
        logger.warn(
          `[CAPI] Connection ${idCfg} pausada por error de auth: ${result.errorCode}`,
        );
        break; // detener procesamiento de esta conexión
      }
      stats.failed++;
    }
  }

  return stats;
}

/**
 * Runner principal del cron
 */
async function runCapiSender() {
  if (isRunning) {
    logger.warn('[CAPI Cron] Ejecución anterior aún corriendo, skip');
    return;
  }
  isRunning = true;
  const startTime = Date.now();

  try {
    const connections = await db.query(
      `SELECT id_configuracion, ad_account_id, access_token, pixel_id,
              currency, capi_test_event_code
       FROM meta_ad_connections 
       WHERE status = 'active' 
         AND capi_enabled = 1 
         AND pixel_id IS NOT NULL 
         AND pixel_id != ''`,
      { type: db.QueryTypes.SELECT },
    );

    if (!connections.length) {
      return;
    }

    const allStats = [];
    for (const conn of connections) {
      try {
        const stats = await processConnection(conn);
        if (stats.processed > 0) allStats.push(stats);
      } catch (err) {
        logger.error(
          `[CAPI Cron] Error en conexión ${conn.id_configuracion}: ${err.message}`,
        );
      }
    }

    if (allStats.length) {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      const totals = allStats.reduce(
        (acc, x) => ({
          processed: acc.processed + x.processed,
          sent: acc.sent + x.sent,
          no_match: acc.no_match + x.no_match,
          failed: acc.failed + x.failed,
        }),
        { processed: 0, sent: 0, no_match: 0, failed: 0 },
      );
      logger.info(
        `[CAPI Cron] ${elapsed}s · ${totals.processed} procesadas · ${totals.sent} ✓ · ${totals.no_match} sin match · ${totals.failed} ✗`,
      );
    }
  } catch (err) {
    logger.error(`[CAPI Cron] Error general: ${err.message}`);
  } finally {
    isRunning = false;
  }
}

module.exports = {
  runCapiSender,
  processConnection,
  findAdMatchesForOrders,
};
