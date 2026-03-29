const express = require('express');
const router = express.Router();

const { protect } = require('../middlewares/auth.middleware');
const checkPlanActivo = require('../middlewares/checkPlanActivo.middleware');
const shopifyCtrl = require('../controllers/shopify.controller');

// ─── OAuth (callback NO requiere protect porque viene de Shopify) ────────────
router.get('/callback', shopifyCtrl.callback);

// ─── Todo lo demás requiere autenticación ────────────────────────────────────
router.use(protect);

// ─── Conexión ────────────────────────────────────────────────────────────────
router.post('/auth', checkPlanActivo, shopifyCtrl.iniciar_auth);
router.get('/status', shopifyCtrl.status);
router.delete('/disconnect', shopifyCtrl.disconnect);

// ─── Productos de la tienda conectada ────────────────────────────────────────
router.get('/products', checkPlanActivo, shopifyCtrl.listar_productos);

// ─── Subir imágenes ──────────────────────────────────────────────────────────
router.post(
  '/upload-product-image',
  checkPlanActivo,
  shopifyCtrl.subir_imagen_producto,
);
router.post(
  '/upload-description-image',
  checkPlanActivo,
  shopifyCtrl.insertar_imagen_descripcion,
);
router.post('/upload-batch', checkPlanActivo, shopifyCtrl.subir_batch);

module.exports = router;
