/**
 * marketing_control.controller.js — Sala de Control de Marketing.
 *
 * Cruza Meta Ads + Dropi "Compra por" para encontrar el ÁNGULO GANADOR
 * (qué creativo trae órdenes ENTREGADAS RENTABLES vs solo mensajes baratos).
 *
 * ATRIBUCIÓN EXACTA: usa el token Dropi de la cuenta "Compra por" (sub=94375,
 * aud=IMPORSUIT) que recibe SOLO órdenes de la conexión IMPORCHAT 277 (Meta Ads).
 * 1:1 real, sin contaminación de canales orgánicos.
 *
 * Endpoints:
 *   GET /api/v1/marketing-control/funnel?id_configuracion&since&until
 *   GET /api/v1/marketing-control/top-ads?id_configuracion&since&until&limit
 */

const axios = require('axios');
const catchAsync = require('../utils/catchAsync');
const AppError = require('../utils/appError');
const logger = require('../utils/logger');

// ───── Config ─────
const DROPI_BASE_EC = process.env.DROPI_BASE_URL_EC || 'https://api.dropi.ec/integrations';
const DROPI_KEY_HEADER = process.env.DROPI_KEY_HEADER || 'dropi-integration-key';
const COMPRA_POR_TOKEN = process.env.DROPI_COMPRA_POR_API_KEY || '';

// Default conexión Meta Ads (la única con Meta hoy, verificada 2026-05-10)
const DEFAULT_CONFIG_ID = parseInt(process.env.MC_DEFAULT_CONFIG_ID || '277', 10);

// Caché in-memory del fetch all Dropi Compra por (5 min)
const _CP_CACHE = { data: null, fetchedAt: 0, tokenHash: '' };
const CP_CACHE_TTL_MS = 5 * 60 * 1000;
const PAGE_SIZE = 50;
const MAX_PAGES = 50;

// Status mapping
const STATUS_ENTREGADO = new Set(['ENTREGADO']);
const STATUS_DEVUELTO = new Set(['DEVOLUCION', 'DEVUELTO']);
const STATUS_CANCELADO = new Set(['CANCELADO', 'RECHAZADO']);
const STATUS_EN_CAMINO = new Set([
  'PENDIENTE', 'PENDIENTE CONFIRMACION', 'GUIA_GENERADA', 'GUIA GENERADA',
  'EN DISTRIBUCIÓN A CLIENTE', 'INGRESANDO OPERATIVO A',
  'PARA RETIRO EN AGENCIA SERVIENTREGA', 'NOVEDAD',
]);

// ───── Helpers ─────

function safeDiv(num, den) {
  return den ? Number(num) / Number(den) : 0;
}

function validateRange(since, until) {
  const re = /^\d{4}-\d{2}-\d{2}$/;
  if (!re.test(since) || !re.test(until)) {
    throw new AppError('Formato de fecha inválido — usa YYYY-MM-DD', 400);
  }
  const dSince = new Date(since + 'T00:00:00Z');
  const dUntil = new Date(until + 'T23:59:59Z');
  if (dSince > dUntil) throw new AppError('since debe ser <= until', 400);
  const diffDays = Math.floor((dUntil - dSince) / 86400000);
  if (diffDays > 180) throw new AppError('Rango máximo: 180 días', 400);
}

function _hashToken(t) {
  // simple non-crypto hash for cache key
  let h = 0;
  for (let i = 0; i < t.length; i++) h = (h << 5) - h + t.charCodeAt(i) | 0;
  return String(h);
}

async function fetchDropiPage(token, start, pageSize = PAGE_SIZE) {
  // El token IMPORSUIT tiene IP allowlist a 98.91.50.83 → este server.
  // No hace falta SOCKS5 (a diferencia del ERP que está en otra IP).
  const url = `${DROPI_BASE_EC}/orders/myorders?result_number=${pageSize}&start=${start}`;
  const headers = { [DROPI_KEY_HEADER]: token };
  const resp = await axios.get(url, { headers, timeout: 30000 });
  if (resp.status !== 200) {
    throw new Error(`Dropi ${resp.status}: ${JSON.stringify(resp.data).slice(0, 200)}`);
  }
  return (resp.data && resp.data.objects) || [];
}

async function fetchAllCompraPor() {
  if (!COMPRA_POR_TOKEN) {
    throw new AppError(
      'DROPI_COMPRA_POR_API_KEY no configurado en .env del backend',
      500,
    );
  }
  const tokenHash = _hashToken(COMPRA_POR_TOKEN);
  const now = Date.now();
  if (
    _CP_CACHE.data
    && _CP_CACHE.tokenHash === tokenHash
    && (now - _CP_CACHE.fetchedAt) < CP_CACHE_TTL_MS
  ) {
    return _CP_CACHE.data;
  }
  const all = [];
  let start = 0;
  for (let i = 0; i < MAX_PAGES; i++) {
    const page = await fetchDropiPage(COMPRA_POR_TOKEN, start);
    if (page.length === 0) break;
    all.push(...page);
    if (page.length < PAGE_SIZE) break;
    start += PAGE_SIZE;
  }
  _CP_CACHE.data = all;
  _CP_CACHE.fetchedAt = now;
  _CP_CACHE.tokenHash = tokenHash;
  if (logger && logger.info) logger.info(`compra_por_fetched count=${all.length}`);
  return all;
}

function aggDropiOrders(orders, since, until) {
  const sinceDt = since + 'T00:00:00';
  const untilDt = until + 'T23:59:59';
  const filt = orders.filter(o => {
    const ca = o.created_at || '';
    return ca >= sinceDt && ca <= untilDt;
  });

  let entregadas = 0, devueltas = 0, canceladas = 0, enCamino = 0;
  let revenue = 0, ventaBruta = 0;
  for (const o of filt) {
    const s = o.status || '';
    const total = parseFloat(o.total_order || 0);
    ventaBruta += total;
    if (STATUS_ENTREGADO.has(s)) {
      entregadas++;
      revenue += total;
    } else if (STATUS_DEVUELTO.has(s)) devueltas++;
    else if (STATUS_CANCELADO.has(s)) canceladas++;
    else if (STATUS_EN_CAMINO.has(s)) enCamino++;
  }

  return {
    ordenesTotal: filt.length,
    entregadas,
    devueltas,
    canceladas,
    enCamino,
    revenueEntregado: Math.round(revenue * 100) / 100,
    ventaBrutaTotal: Math.round(ventaBruta * 100) / 100,
    ticketPromedio: entregadas ? Math.round((revenue / entregadas) * 100) / 100 : 0,
  };
}

/**
 * Llama internamente al endpoint /api/v1/meta_ads/insights/account del mismo
 * backend (localhost:3000) reusando el JWT del request entrante.
 */
async function callInternal(req, path) {
  const auth = req.headers.authorization || '';
  const url = `http://127.0.0.1:${process.env.PORT || 3000}${path}`;
  const resp = await axios.get(url, {
    headers: { Authorization: auth },
    timeout: 30000,
    validateStatus: () => true,
  });
  if (resp.status >= 400) {
    throw new Error(`internal ${path} → ${resp.status}: ${JSON.stringify(resp.data).slice(0, 200)}`);
  }
  return resp.data;
}

// ───── Endpoints ─────

exports.funnel = catchAsync(async (req, res, next) => {
  const idConfig = parseInt(req.query.id_configuracion || DEFAULT_CONFIG_ID, 10);
  const since = String(req.query.since || '');
  const until = String(req.query.until || '');
  validateRange(since, until);

  // 1) Meta Ads account (interno) + 2) Dropi Compra por
  const [metaData, allCp] = await Promise.all([
    callInternal(req, `/api/v1/meta_ads/insights/account?id_configuracion=${idConfig}&since=${since}&until=${until}`),
    fetchAllCompraPor(),
  ]);

  if (!metaData.success) {
    return next(new AppError(`Meta Ads fail: ${(metaData.message || '').slice(0, 200)}`, 502));
  }
  const m = metaData.data || {};

  const gasto = parseFloat(m.spend || 0);
  const impr = parseInt(m.impressions || 0, 10);
  const clicks = parseInt(m.clicks || 0, 10);
  const msgs = parseInt(m.messaging_conversations || 0, 10);
  const cpaMsg = parseFloat(m.cpa_messaging || 0);

  const agg = aggDropiOrders(allCp, since, until);
  const { ordenesTotal, entregadas, revenueEntregado: revenue } = agg;

  res.json({
    rango: { since, until },
    config_meta: { id_configuracion: idConfig, currency: metaData.currency || 'USD' },
    embudo: {
      impresiones: impr,
      clicks,
      msgs_wa: msgs,
      ordenes_dropi: ordenesTotal,
      entregadas,
      devueltas: agg.devueltas,
      canceladas: agg.canceladas,
      en_camino: agg.enCamino,
    },
    dinero: {
      gasto_ads: Math.round(gasto * 100) / 100,
      revenue_entregado: revenue,
      venta_bruta: agg.ventaBrutaTotal,
      ticket_promedio_entrega: agg.ticketPromedio,
      roas_real: Math.round(safeDiv(revenue, gasto) * 100) / 100,
      cpa_mensaje: Math.round(cpaMsg * 100) / 100,
      cpa_orden: Math.round(safeDiv(gasto, ordenesTotal) * 100) / 100,
      cpa_entrega: Math.round(safeDiv(gasto, entregadas) * 100) / 100,
    },
    tasas_pct: {
      ctr: Math.round(safeDiv(clicks, impr) * 10000) / 100,
      click_to_msg: Math.round(safeDiv(msgs, clicks) * 10000) / 100,
      msg_to_orden: Math.round(safeDiv(ordenesTotal, msgs) * 10000) / 100,
      orden_to_entrega: Math.round(safeDiv(entregadas, ordenesTotal) * 10000) / 100,
    },
    atribucion: {
      tipo: 'exacta_canal_dropi',
      detalle: 'Órdenes del canal Dropi "Compra por" (sub=94375 IMPORSUIT), que recibe exclusivamente tráfico de la conexión IMPORCHAT 277.',
      total_cuenta_dropi: allCp.length,
    },
  });
});

exports.topAds = catchAsync(async (req, res, next) => {
  const idConfig = parseInt(req.query.id_configuracion || DEFAULT_CONFIG_ID, 10);
  const since = String(req.query.since || '');
  const until = String(req.query.until || '');
  const limit = Math.min(50, parseInt(req.query.limit || '20', 10));
  validateRange(since, until);

  const [acctResp, adsResp, allCp] = await Promise.all([
    callInternal(req, `/api/v1/meta_ads/insights/account?id_configuracion=${idConfig}&since=${since}&until=${until}`),
    callInternal(req, `/api/v1/meta_ads/insights/top-ads?id_configuracion=${idConfig}&since=${since}&until=${until}`),
    fetchAllCompraPor(),
  ]);

  if (!acctResp.success) {
    return next(new AppError(`Meta acct fail: ${(acctResp.message || '').slice(0, 200)}`, 502));
  }
  if (!adsResp.success) {
    return next(new AppError(`Meta ads fail: ${(adsResp.message || '').slice(0, 200)}`, 502));
  }

  const acct = acctResp.data || {};
  const ads = adsResp.data || [];
  const totalMsgs = parseInt(acct.messaging_conversations || 0, 10);

  const agg = aggDropiOrders(allCp, since, until);
  const { ordenesTotal: totalOrdenes, entregadas: totalEntregadas, revenueEntregado: totalRevenue } = agg;

  const enriched = ads.slice(0, limit).map(ad => {
    const msgsAd = parseInt(ad.messaging_conversations || 0, 10);
    const spend = parseFloat(ad.spend || 0);
    const share = safeDiv(msgsAd, totalMsgs);
    const ordenesEst = totalOrdenes * share;
    const entregadasEst = totalEntregadas * share;
    const revenueEst = totalRevenue * share;
    return {
      ad_id: ad.ad_id,
      ad_name: ad.ad_name,
      campaign_name: ad.campaign_name,
      post_id: ad.post_id,
      thumbnail_url: ad.thumbnail_url,
      spend: Math.round(spend * 100) / 100,
      impressions: parseInt(ad.impressions || 0, 10),
      clicks: parseInt(ad.clicks || 0, 10),
      ctr: Math.round(parseFloat(ad.ctr || 0) * 100) / 100,
      cpc: Math.round(parseFloat(ad.cpc || 0) * 10000) / 10000,
      msgs: msgsAd,
      cpa_msg: Math.round(parseFloat(ad.cpa_messaging || 0) * 100) / 100,
      share_msgs_pct: Math.round(share * 10000) / 100,
      ordenes_estimadas: Math.round(ordenesEst * 10) / 10,
      entregadas_estimadas: Math.round(entregadasEst * 10) / 10,
      revenue_estimado: Math.round(revenueEst * 100) / 100,
      roas_estimado: Math.round(safeDiv(revenueEst, spend) * 100) / 100,
      cpa_orden_estimado: ordenesEst ? Math.round(safeDiv(spend, ordenesEst) * 100) / 100 : 0,
    };
  });

  enriched.sort((a, b) => b.roas_estimado - a.roas_estimado);

  res.json({
    rango: { since, until },
    config_meta: { id_configuracion: idConfig },
    totales_rango: {
      msgs_meta: totalMsgs,
      ordenes_dropi: totalOrdenes,
      entregadas_dropi: totalEntregadas,
      revenue_entregado: totalRevenue,
      gasto_total: Math.round(parseFloat(acct.spend || 0) * 100) / 100,
    },
    items: enriched,
    total_items: enriched.length,
    atribucion: {
      tipo: 'exacta_canal + share_msgs_por_ad',
      detalle: 'Totales del canal Compra por (1:1 Meta) repartidos entre ads por share de mensajes.',
    },
  });
});

exports.healthz = (req, res) => {
  res.json({
    ok: true,
    has_compra_por_token: Boolean(COMPRA_POR_TOKEN),
    cache_size: (_CP_CACHE.data && _CP_CACHE.data.length) || 0,
    cache_age_seconds: _CP_CACHE.fetchedAt ? Math.floor((Date.now() - _CP_CACHE.fetchedAt) / 1000) : null,
  });
};
