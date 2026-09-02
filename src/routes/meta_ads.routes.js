const express = require('express');
const multer = require('multer');
const router = express.Router();
const metaAdsCtrl = require('../controllers/meta_ads.controller');
const launcherCtrl = require('../controllers/meta_ads_launcher.controller');
const { protect } = require('../middlewares/auth.middleware');

/* Imagen del creativo: en memoria, se reenvía en base64 a act_X/adimages.
   8 MB = tope de Meta para imágenes de anuncio. */
const MIMES_IMAGEN = new Set([
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/webp',
]);
const subirCreativo = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (MIMES_IMAGEN.has(file.mimetype)) return cb(null, true);
    cb(new Error('Formato no permitido: usa JPG, PNG o WEBP.'));
  },
}).single('archivo');

const subirCreativoHandler = (req, res, next) => {
  subirCreativo(req, res, (err) => {
    if (err) {
      const message =
        err.code === 'LIMIT_FILE_SIZE'
          ? 'La imagen supera los 8 MB.'
          : err.message;
      return res.status(400).json({ success: false, message });
    }
    next();
  });
};

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

// ── Lanzador de campañas (tab "Lanzador") ──
// A diferencia del resto del módulo, va con protect: estos endpoints crean
// campañas que gastan dinero real en la cuenta del cliente.
router.get('/launcher/contexto', protect, launcherCtrl.contexto);
router.get('/launcher/plantillas', protect, launcherCtrl.listarPlantillas);
router.post(
  '/launcher/plantillas/guardar',
  protect,
  launcherCtrl.guardarPlantilla,
);
router.post(
  '/launcher/plantillas/eliminar',
  protect,
  launcherCtrl.eliminarPlantilla,
);
router.post(
  '/launcher/subir-imagen',
  protect,
  subirCreativoHandler,
  launcherCtrl.subirImagen,
);
router.post('/launcher/lanzar', protect, launcherCtrl.lanzar);
router.get('/launcher/lanzamientos', protect, launcherCtrl.listarLanzamientos);

module.exports = router;
