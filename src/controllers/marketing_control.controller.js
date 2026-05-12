/**
 * marketing_control.controller.js — Sala de Control de Marketing
 *
 * Endpoints:
 *   GET /api/v1/marketing-control/dashboard?id_configuracion&since&until&limit
 *   GET /api/v1/marketing-control/healthz?id_configuracion
 */

const axios = require('axios');
const catchAsync = require('../utils/catchAsync');
const AppError = require('../utils/appError');
const { db } = require('../database/config');
const DropiIntegrations = require('../models/dropi_integrations.model');
const logger = require('../utils/logger');

// ════════════════════════════════════════════════════════════
// Helpers
// ════════════════════════════════════════════════════════════

function safeDiv(num, den) {
  return den ? Number(num) / Number(den) : 0;
}

function validateRange(since, until) {
  const re = /^\d{4}-\d{2}-\d{2}$/;
  if (!re.test(since) || !re.test(until)) {
    throw new AppError('Formato de fecha YYYY-MM-DD requerido', 400);
  }
  if (new Date(since) > new Date(until)) {
    throw new AppError('since debe ser <= until', 400);
  }
  const diffDays = Math.floor((new Date(until) - new Date(since)) / 86400000);
  if (diffDays > 180) throw new AppError('Rango máximo 180 días', 400);
}

function normalizePhone(p) {
  let d = String(p || '').replace(/\D/g, '');
  if (d.startsWith('593')) d = d.slice(3);
  if (d.startsWith('0')) d = d.slice(1);
  return d.slice(-9);
}

async function callInternal(req, path, { method = 'get', data = null } = {}) {
  const auth = req.headers.authorization || '';
  const url = `http://127.0.0.1:${process.env.PORT || 3000}${path}`;

  const config = {
    method,
    url,
    headers: { Authorization: auth },
    timeout: 30000,
    validateStatus: () => true,
  };

  if (data !== null && data !== undefined && method.toLowerCase() !== 'get') {
    config.data = data;
    config.headers['Content-Type'] = 'application/json';
  }

  const resp = await axios(config);

  if (resp.status >= 400) {
    throw new AppError(
      `Internal ${path} → ${resp.status}: ${JSON.stringify(resp.data).slice(0, 300)}`,
      502,
    );
  }
  return resp.data;
}

async function ensureDropiCacheFresh({
  req,
  id_configuracion,
  since,
  until,
  maxAgeMinutes = 15,
}) {
  const [rows] = await db.query(
    `SELECT MAX(synced_at) AS last_sync, COUNT(*) AS total
     FROM dropi_orders_cache
     WHERE id_configuracion = :idCfg
       AND order_created_at BETWEEN :from AND :until`,
    {
      replacements: {
        idCfg: id_configuracion,
        from: `${since} 00:00:00`,
        until: `${until} 23:59:59`,
      },
    },
  );

  const fresh = rows?.[0] || {};
  const lastSync = fresh.last_sync ? new Date(fresh.last_sync) : null;
  const totalCached = Number(fresh.total || 0);
  const ageMin = lastSync
    ? Math.floor((Date.now() - lastSync.getTime()) / 60000)
    : null;
  const isStale = !lastSync || ageMin > maxAgeMinutes;

  if (isStale) {
    axios
      .post(
        `http://127.0.0.1:${process.env.PORT || 3000}/api/v1/dropi/dashboard-stats`,
        { id_configuracion, from: since, until },
        {
          headers: {
            Authorization: req.headers.authorization || '',
            'Content-Type': 'application/json',
          },
          timeout: 5000,
          validateStatus: () => true,
        },
      )
      .catch((err) => {
        if (logger?.warn) logger.warn(`mc-sync-trigger-failed: ${err.message}`);
      });
  }

  return { lastSync, ageMin, isStale, totalCached };
}

// ════════════════════════════════════════════════════════════
// GET /dashboard
// ════════════════════════════════════════════════════════════

const WINDOW_HOURS = 72;

exports.dashboard = catchAsync(async (req, res, next) => {
  const id_configuracion = parseInt(req.query.id_configuracion, 10);
  const since = String(req.query.since || '');
  const until = String(req.query.until || '');
  const limit = Math.min(50, parseInt(req.query.limit || '30', 10));
  validateRange(since, until);
  if (!id_configuracion)
    return next(new AppError('id_configuracion es requerido', 400));

  const cacheStatus = await ensureDropiCacheFresh({
    req,
    id_configuracion,
    since,
    until,
  });

  const tr = encodeURIComponent(JSON.stringify({ since, until }));
  const windowMs = WINDOW_HOURS * 60 * 60 * 1000;
  const sinceExt = new Date(new Date(since + 'T00:00:00').getTime() - windowMs)
    .toISOString()
    .slice(0, 19)
    .replace('T', ' ');

  const [acctResp, adsResp, aggResult, orderResult, msgResult] =
    await Promise.all([
      callInternal(
        req,
        `/api/v1/meta_ads/insights/account?id_configuracion=${id_configuracion}&time_range=${tr}`,
      ),
      callInternal(
        req,
        `/api/v1/meta_ads/insights/top-ads?id_configuracion=${id_configuracion}&time_range=${tr}&limit=50`,
      ),
      // AGREGADO: utilidad_entregada = SUM(dropshipper_profit) cuando entregada
      db.query(
        `SELECT
         COUNT(*) AS ordenes_total,
         SUM(CASE WHEN classified_status = 'entregada'  THEN 1 ELSE 0 END) AS entregadas,
         SUM(CASE WHEN classified_status = 'devolucion' THEN 1 ELSE 0 END) AS devueltas,
         SUM(CASE WHEN classified_status = 'cancelada'  THEN 1 ELSE 0 END) AS canceladas,
         SUM(CASE WHEN classified_status IN ('en_transito','en_reparto','novedad','retiro_agencia','guia_generada','pendiente') THEN 1 ELSE 0 END) AS en_camino,
         SUM(CASE WHEN classified_status = 'entregada'  THEN COALESCE(total_order, 0) ELSE 0 END) AS revenue_entregado,
         SUM(CASE WHEN classified_status = 'entregada'  THEN COALESCE(dropshipper_profit, 0) ELSE 0 END) AS utilidad_entregada,
         SUM(COALESCE(total_order, 0)) AS venta_bruta
       FROM dropi_orders_cache
       WHERE id_configuracion = :idCfg
         AND order_created_at BETWEEN :from AND :until`,
        {
          replacements: {
            idCfg: id_configuracion,
            from: `${since} 00:00:00`,
            until: `${until} 23:59:59`,
          },
        },
      ),
      // AGREGADO: dropshipper_profit en select de cada orden
      db.query(
        `SELECT dropi_order_id, phone, name, surname, classified_status,
              total_order, dropshipper_profit, product_names, order_created_at
       FROM dropi_orders_cache
       WHERE id_configuracion = :idCfg
         AND order_created_at BETWEEN :from AND :until`,
        {
          replacements: {
            idCfg: id_configuracion,
            from: `${since} 00:00:00`,
            until: `${until} 23:59:59`,
          },
        },
      ),
      db.query(
        `SELECT cpa.id_cliente, cpa.source_id, cpa.ctwa_clid, cpa.headline,
              cpa.created_at AS msg_at,
              cc.celular_cliente, cc.telefono_limpio
       FROM cliente_productos_ad cpa
       INNER JOIN clientes_chat_center cc ON cc.id = cpa.id_cliente
       WHERE cpa.id_configuracion = :idCfg
         AND cpa.source_id IS NOT NULL
         AND cpa.source_id != ''
         AND cpa.created_at BETWEEN :fromExt AND :until`,
        {
          replacements: {
            idCfg: id_configuracion,
            fromExt: sinceExt,
            until: `${until} 23:59:59`,
          },
        },
      ),
    ]);

  if (!acctResp.success)
    return next(new AppError(`Meta account: ${acctResp.message}`, 502));
  if (!adsResp.success)
    return next(new AppError(`Meta top-ads: ${adsResp.message}`, 502));

  const m = acctResp.data || {};
  const ads = adsResp.data || [];
  const [aggRows] = aggResult;
  const [orderRows] = orderResult;
  const [msgRows] = msgResult;

  // Index mensajes por teléfono normalizado
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

  // Match 1:1 last-touch — AHORA TAMBIÉN ACUMULA UTILIDAD (profit)
  const bySourceId = new Map();
  let matched = 0;
  let huerfanas = 0;

  for (const order of orderRows) {
    const phoneKey = normalizePhone(order.phone);
    if (!phoneKey) {
      huerfanas++;
      continue;
    }
    const candidates = msgsByPhone.get(phoneKey) || [];
    if (!candidates.length) {
      huerfanas++;
      continue;
    }

    const orderTime = new Date(order.order_created_at);
    const windowStart = new Date(orderTime.getTime() - windowMs);
    const winner = candidates.find(
      (c) => c.created_at >= windowStart && c.created_at <= orderTime,
    );
    if (!winner) {
      huerfanas++;
      continue;
    }

    matched++;
    const sid = winner.source_id;
    if (!bySourceId.has(sid)) {
      bySourceId.set(sid, {
        ordenes: 0,
        entregadas: 0,
        devueltas: 0,
        canceladas: 0,
        en_camino: 0,
        revenue: 0,
        utilidad: 0,
        orders_sample: [],
        last_ctwa_clid: winner.ctwa_clid,
        last_headline: winner.headline,
      });
    }
    const grp = bySourceId.get(sid);
    grp.ordenes++;
    const total = Number(order.total_order || 0);
    const profit = Number(order.dropshipper_profit || 0);
    const st = order.classified_status;

    if (st === 'entregada') {
      grp.entregadas++;
      grp.revenue += total;
      grp.utilidad += profit;
    } else if (st === 'devolucion') grp.devueltas++;
    else if (st === 'cancelada') grp.canceladas++;
    else if (
      [
        'en_transito',
        'en_reparto',
        'novedad',
        'retiro_agencia',
        'guia_generada',
        'pendiente',
      ].includes(st)
    )
      grp.en_camino++;

    if (grp.orders_sample.length < 5) {
      grp.orders_sample.push({
        dropi_order_id: order.dropi_order_id,
        status: st,
        total,
        profit, // AGREGADO
        client_name: `${order.name || ''} ${order.surname || ''}`.trim(),
        ctwa_clid: winner.ctwa_clid,
        msg_at: winner.created_at.toISOString(),
        order_at: orderTime.toISOString(),
        hours_msg_to_order:
          Math.round(((orderTime - winner.created_at) / 3600000) * 10) / 10,
      });
    }
  }

  // Enriquecer top ads — agrega utilidad_estimada, roi_estimado, effective_status
  const enriched = ads.slice(0, limit).map((ad) => {
    const adId = String(ad.ad_id);
    const real = bySourceId.get(adId) || {
      ordenes: 0,
      entregadas: 0,
      devueltas: 0,
      canceladas: 0,
      en_camino: 0,
      revenue: 0,
      utilidad: 0,
      orders_sample: [],
      last_ctwa_clid: null,
      last_headline: null,
    };
    const spend = Number(ad.spend || 0);
    return {
      ad_id: ad.ad_id,
      ad_name: ad.ad_name,
      campaign_name: ad.campaign_name,
      post_id: ad.post_id,
      thumbnail_url: ad.thumbnail_url,
      effective_status: ad.effective_status || null, // AGREGADO
      spend: Math.round(spend * 100) / 100,
      impressions: Number(ad.impressions || 0),
      clicks: Number(ad.clicks || 0),
      ctr: Number(ad.ctr || 0),
      cpc: Number(ad.cpc || 0),
      msgs: Number(ad.messaging_conversations || 0),
      cpa_msg: Number(ad.cpa_messaging || 0),
      ordenes_estimadas: real.ordenes,
      entregadas_estimadas: real.entregadas,
      devueltas_atribuidas: real.devueltas,
      canceladas_atribuidas: real.canceladas,
      en_camino_atribuidas: real.en_camino,
      revenue_estimado: Math.round(real.revenue * 100) / 100,
      utilidad_estimada: Math.round(real.utilidad * 100) / 100, // AGREGADO
      roas_estimado: spend ? Math.round((real.revenue / spend) * 100) / 100 : 0,
      roi_estimado: spend ? Math.round((real.utilidad / spend) * 100) / 100 : 0, // AGREGADO
      cpa_orden_estimado: real.ordenes
        ? Math.round((spend / real.ordenes) * 100) / 100
        : 0,
      cpa_entrega: real.entregadas
        ? Math.round((spend / real.entregadas) * 100) / 100
        : 0,
      product_attributed: real.last_headline,
      last_ctwa_clid: real.last_ctwa_clid,
      sample_orders: real.orders_sample,
    };
  });
  // Ordenar por ROI desc (antes era ROAS)
  enriched.sort((a, b) => b.roi_estimado - a.roi_estimado);

  // Totales
  const agg = aggRows[0] || {};
  const gasto = Number(m.spend || 0);
  const impr = Number(m.impressions || 0);
  const clicks = Number(m.clicks || 0);
  const msgs = Number(m.messaging_conversations || 0);
  const cpaMsg = Number(m.cpa_messaging || 0);
  const ordenesTotal = Number(agg.ordenes_total || 0);
  const entregadas = Number(agg.entregadas || 0);
  const revenue = Number(agg.revenue_entregado || 0);
  const utilidad = Number(agg.utilidad_entregada || 0);
  const ventaBruta = Number(agg.venta_bruta || 0);
  const ticketPromedio = entregadas > 0 ? revenue / entregadas : 0;
  const ticketUtilidad = entregadas > 0 ? utilidad / entregadas : 0;

  // Suma de utilidad atribuida (para totals del banner de ads)
  const utilidadAtribuida = enriched.reduce(
    (s, a) => s + Number(a.utilidad_estimada || 0),
    0,
  );

  return res.json({
    rango: { since, until },
    window_hours: WINDOW_HOURS,
    config: { id_configuracion, currency: acctResp.currency || 'USD' },

    funnel: {
      embudo: {
        impresiones: impr,
        clicks,
        msgs_wa: msgs,
        ordenes_dropi: ordenesTotal,
        entregadas,
        devueltas: Number(agg.devueltas || 0),
        canceladas: Number(agg.canceladas || 0),
        en_camino: Number(agg.en_camino || 0),
      },
      dinero: {
        gasto_ads: Math.round(gasto * 100) / 100,
        revenue_entregado: Math.round(revenue * 100) / 100,
        utilidad_entregada: Math.round(utilidad * 100) / 100, // AGREGADO
        ticket_promedio_utilidad: Math.round(ticketUtilidad * 100) / 100, // AGREGADO
        venta_bruta: Math.round(ventaBruta * 100) / 100,
        ticket_promedio_entrega: Math.round(ticketPromedio * 100) / 100,
        roas_real: Math.round(safeDiv(revenue, gasto) * 100) / 100,
        roi_real: Math.round(safeDiv(utilidad, gasto) * 100) / 100, // AGREGADO
        cpa_mensaje: Math.round(cpaMsg * 100) / 100,
        cpa_orden: Math.round(safeDiv(gasto, ordenesTotal) * 100) / 100,
        cpa_entrega: Math.round(safeDiv(gasto, entregadas) * 100) / 100,
      },
      tasas_pct: {
        ctr: Math.round(safeDiv(clicks, impr) * 10000) / 100,
        click_to_msg: Math.round(safeDiv(msgs, clicks) * 10000) / 100,
        msg_to_orden: Math.round(safeDiv(ordenesTotal, msgs) * 10000) / 100,
        orden_to_entrega:
          Math.round(safeDiv(entregadas, ordenesTotal) * 10000) / 100,
      },
    },

    attribution: {
      totales_rango: {
        msgs_meta: msgs,
        ordenes_dropi_total: orderRows.length,
        ordenes_atribuidas: matched,
        ordenes_huerfanas: huerfanas,
        pct_atribuidas: orderRows.length
          ? Math.round((matched / orderRows.length) * 1000) / 10
          : 0,
        ads_con_ventas: bySourceId.size,
        gasto_total: Math.round(gasto * 100) / 100,
        revenue_entregado_atribuido:
          Math.round(
            enriched.reduce((s, a) => s + Number(a.revenue_estimado), 0) * 100,
          ) / 100,
        utilidad_entregada_atribuida: Math.round(utilidadAtribuida * 100) / 100, // AGREGADO
      },
      items: enriched,
      total_items: enriched.length,
      tipo: `1:1_telefono_ventana_${WINDOW_HOURS}h`,
      metodo: 'last-touch',
    },

    cache: {
      age_minutes: cacheStatus.ageMin,
      total_orders: cacheStatus.totalCached,
      was_stale_triggered_sync: cacheStatus.isStale,
    },
  });
});

// ════════════════════════════════════════════════════════════
// GET /healthz
// ════════════════════════════════════════════════════════════

exports.healthz = catchAsync(async (req, res) => {
  const id_configuracion = parseInt(req.query.id_configuracion, 10);
  if (!id_configuracion) {
    return res.json({ ok: false, error: 'id_configuracion requerido' });
  }

  const integration = await DropiIntegrations.findOne({
    where: { id_configuracion, deleted_at: null, is_active: 1 },
    attributes: ['id', 'country_code', 'store_name', 'integration_key_last4'],
  });

  const [counts] = await db.query(
    `SELECT
       (SELECT COUNT(*) FROM dropi_orders_cache WHERE id_configuracion = :idCfg) AS cache_size,
       (SELECT MAX(synced_at) FROM dropi_orders_cache WHERE id_configuracion = :idCfg) AS last_sync,
       (SELECT COUNT(*) FROM cliente_productos_ad WHERE id_configuracion = :idCfg AND source_id IS NOT NULL AND source_id != '') AS msgs_with_ad`,
    { replacements: { idCfg: id_configuracion } },
  );

  const row = counts[0] || {};
  return res.json({
    ok: true,
    id_configuracion,
    dropi_integration: integration
      ? {
          active: true,
          country: integration.country_code,
          store: integration.store_name,
          key_last4: integration.integration_key_last4,
        }
      : { active: false },
    dropi_orders_cache: {
      total: Number(row.cache_size || 0),
      last_sync: row.last_sync || null,
      age_minutes: row.last_sync
        ? Math.floor((Date.now() - new Date(row.last_sync).getTime()) / 60000)
        : null,
    },
    cliente_productos_ad: {
      msgs_with_source_id: Number(row.msgs_with_ad || 0),
    },
  });
});
