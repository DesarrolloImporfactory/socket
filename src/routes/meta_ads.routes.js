const express = require('express');
const multer = require('multer');
const fs = require('fs');
const os = require('os');
const path = require('path');
const router = express.Router();
const metaAdsCtrl = require('../controllers/meta_ads.controller');
const launcherCtrl = require('../controllers/meta_ads_launcher.controller');
const {
  protect,
  protectConfigOwner,
} = require('../middlewares/auth.middleware');
const excluirRoles = require('../middlewares/excluirRoles.middleware');

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

/* Media del anuncio (imagen o video). Los videos van a act_X/advideos.
   El archivo NO pasa por memoria: multer lo deja en un temporal de disco y
   el service lo transmite a Meta en flujo (fs.openAsBlob), así el tope puede
   ser generoso sin arriesgar la RAM del servidor con varias subidas a la
   vez. El controller borra el temporal al terminar. Las imágenes mantienen
   su tope de 8 MB (límite de Meta) validado en el controller. */
const MAX_MEDIA_MB = 300;
const MIMES_MEDIA = new Set([
  ...MIMES_IMAGEN,
  'video/mp4',
  'video/quicktime',
  'video/webm',
]);
const DIR_TMP_MEDIA = path.join(os.tmpdir(), 'chatcenter-ads-media');
const subirMediaAd = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      fs.mkdir(DIR_TMP_MEDIA, { recursive: true }, (err) =>
        cb(err, DIR_TMP_MEDIA),
      );
    },
    filename: (req, file, cb) =>
      cb(
        null,
        `${Date.now()}-${Math.random().toString(36).slice(2, 10)}${path.extname(
          file.originalname || '',
        )}`,
      ),
  }),
  limits: { fileSize: MAX_MEDIA_MB * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (MIMES_MEDIA.has(file.mimetype)) return cb(null, true);
    cb(new Error('Formato no permitido: usa JPG, PNG, WEBP o MP4.'));
  },
}).single('archivo');

const subirMediaAdHandler = (req, res, next) => {
  subirMediaAd(req, res, (err) => {
    if (err) {
      const message =
        err.code === 'LIMIT_FILE_SIZE'
          ? `El archivo supera los ${MAX_MEDIA_MB} MB.`
          : err.message;
      return res.status(400).json({ success: false, message });
    }
    next();
  });
};

/* Hasta el 2026-09-22 todo lo de abajo (salvo el lanzador) iba SIN protect:
   con solo un id_configuracion se podía desconectar la cuenta publicitaria,
   pausar campañas o leer la inversión de cualquier cliente, y el repo es
   público. Ahora: sesión obligatoria y la conexión debe ser de la cuenta
   (protectConfigOwner lee id_configuracion de body o query). Todos los
   handlers reciben id_configuracion, así que el guard aplica a todos. */
router.use(protect);
const deLaCuenta = protectConfigOwner;
// Los valores (inversión, ROAS, compras) no son para el asesor de ventas.
// Conectar/desconectar y el lanzador sí: hay asesores encargados de eso.
const sinVentas = excluirRoles('ventas');

// ── Conexión / Desconexión ──
// Devuelve la URL del diálogo de OAuth, o url:null si la app de anuncios
// todavía no migró (entonces el front sigue con FB.login).
router.get('/login-url', deLaCuenta, metaAdsCtrl.getAdsLoginUrl);
router.post('/conectar', deLaCuenta, metaAdsCtrl.conectarAdAccount);
router.post('/desconectar', deLaCuenta, metaAdsCtrl.desconectarAdAccount);
router.get('/conexion', deLaCuenta, metaAdsCtrl.obtenerConexion); // ?id_configuracion=

// ── Insights ──
router.get('/insights/account', deLaCuenta, sinVentas, metaAdsCtrl.insightsAccount); // ?id_configuracion=&date_preset=last_30d
router.get('/insights/campaigns', deLaCuenta, sinVentas, metaAdsCtrl.insightsCampaigns); // ?id_configuracion=&date_preset=last_30d
router.get('/insights/top-ads', deLaCuenta, sinVentas, metaAdsCtrl.insightsTopAds); // ?id_configuracion=&date_preset=last_30d&limit=10

// ── Campañas (status, pausar, activar) ──
router.get('/campaigns', deLaCuenta, metaAdsCtrl.listarCampanias); // ?id_configuracion=
router.post('/campaigns/toggle', deLaCuenta, metaAdsCtrl.toggleCampania); // { id_configuracion, campaign_id, status }

// ── Ads ( pausar/activar un anuncio individual) ──
router.post('/ads/toggle', deLaCuenta, metaAdsCtrl.toggleAd);

// ── Pixel / CAPI ──
router.post('/pixel/auto-detect', deLaCuenta, metaAdsCtrl.autoDetectPixel);
router.post('/pixel/select', deLaCuenta, metaAdsCtrl.selectPixel);
router.get('/pixel/status', deLaCuenta, metaAdsCtrl.getPixelStatus);
router.post('/capi/toggle', deLaCuenta, metaAdsCtrl.toggleCapi);
router.post('/capi/test-send', deLaCuenta, metaAdsCtrl.testSendCapi);
// ── Sync manual (fuerza re-fetch de Meta) ──
router.post('/sync', deLaCuenta, sinVentas, metaAdsCtrl.syncInsights);

// ── Lanzador de campañas (tab "Lanzador") ──
// Estos endpoints crean campañas que gastan dinero real en la cuenta del
// cliente. El protect explícito de cada uno quedó de cuando el resto del
// módulo no lo tenía; hoy es redundante con el router.use de arriba.
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
router.post(
  '/launcher/subir-media',
  protect,
  subirMediaAdHandler,
  launcherCtrl.subirMedia,
);
router.post('/launcher/lanzar', protect, launcherCtrl.lanzar);
router.get('/launcher/geo/buscar', protect, launcherCtrl.buscarGeo);
// Zonas en lote (lista pegada / archivo) y listas guardadas reutilizables
router.post('/launcher/geo/resolver', protect, launcherCtrl.resolverGeo);
router.get('/launcher/geo/listas', protect, launcherCtrl.listarGeoListas); // ?id_configuracion=&pais=
router.post('/launcher/geo/listas/guardar', protect, launcherCtrl.guardarGeoLista);
router.post('/launcher/geo/listas/eliminar', protect, launcherCtrl.eliminarGeoLista);
router.get('/launcher/media/video', protect, launcherCtrl.videoInfo); // ?id_configuracion=&video_id=
router.get('/launcher/lanzamientos', protect, launcherCtrl.listarLanzamientos);

// ── Centro de campañas: TODAS las campañas de la cuenta (sistema + Ads
//    Manager) con métricas del período, y el detalle de anuncios de una.
router.get('/launcher/campanias', protect, launcherCtrl.listarCampanias); // ?id_configuracion=&since=YYYY-MM-DD&until=YYYY-MM-DD
router.get(
  '/launcher/campanias/anuncios',
  protect,
  launcherCtrl.anunciosCampania,
); // ?id_configuracion=&campaign_id=&since=&until=

// ── Reglas automáticas (motor propio de Imporchat) ──
router.get('/launcher/reglas', protect, launcherCtrl.listarReglas);
router.post('/launcher/reglas/guardar', protect, launcherCtrl.guardarRegla);
router.post('/launcher/reglas/eliminar', protect, launcherCtrl.eliminarRegla);
router.post(
  '/launcher/reglas/aplicar-recomendadas',
  protect,
  launcherCtrl.aplicarRecomendadas,
);
router.get('/launcher/reglas/log', protect, launcherCtrl.logReglas);
router.post('/launcher/reglas/ejecutar', protect, launcherCtrl.ejecutarReglas);

// ── Avisos por WhatsApp al dueño cuando una regla actúa ──
router.get('/launcher/avisos', protect, launcherCtrl.estadoAvisos);
router.post('/launcher/avisos/toggle', protect, launcherCtrl.toggleAvisos);

module.exports = router;
