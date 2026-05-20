const express = require('express');
const router = express.Router();
const metaAdsCtrl = require('../controllers/meta_ads.controller');

// ── Conexión / Desconexión ──
router.post('/conectar', metaAdsCtrl.conectarAdAccount);
router.post('/desconectar', metaAdsCtrl.desconectarAdAccount);
router.get('/conexion', metaAdsCtrl.obtenerConexion); // ?id_configuracion=

// ── Insights ──
router.get('/insights/account', metaAdsCtrl.insightsAccount); // ?id_configuracion=&date_preset=last_30d
router.get('/insights/campaigns', metaAdsCtrl.insightsCampaigns); // ?id_configuracion=&date_preset=last_30d
router.get('/insights/top-ads', metaAdsCtrl.insightsTopAds); // ?id_configuracion=&date_preset=last_30d&limit=10

// ── Campañas (status, pausar, activar) ──
router.get('/campaigns', metaAdsCtrl.listarCampanias); // ?id_configuracion=
router.post('/campaigns/toggle', metaAdsCtrl.toggleCampania); // { id_configuracion, campaign_id, status }

// ── Ads ( pausar/activar un anuncio individual) ──
router.post('/ads/toggle', metaAdsCtrl.toggleAd);

// ── Pixel / CAPI ──
router.post('/pixel/auto-detect', metaAdsCtrl.autoDetectPixel);
router.post('/pixel/select', metaAdsCtrl.selectPixel);
router.get('/pixel/status', metaAdsCtrl.getPixelStatus);
router.post('/capi/toggle', metaAdsCtrl.toggleCapi);
router.post('/capi/test-send', metaAdsCtrl.testSendCapi);
// ── Sync manual (fuerza re-fetch de Meta) ──
router.post('/sync', metaAdsCtrl.syncInsights);

module.exports = router;
