const express = require('express');
const router = express.Router();
const crypto = require('crypto');

const { protect } = require('../middlewares/auth.middleware');
const checkPlanActivo = require('../middlewares/checkPlanActivo.middleware');
const shopifyCtrl = require('../controllers/shopify.controller');

// ─── Middleware para verificar HMAC de webhooks Shopify ──────────────────────
function verifyShopifyWebhook(req, res, next) {
  const hmacHeader = req.get('X-Shopify-Hmac-Sha256');
  if (!hmacHeader) return res.status(401).json({ error: 'No HMAC header' });

  const rawBody = req.rawBody;
  if (!rawBody) return res.status(400).json({ error: 'No raw body' });

  const generated = crypto
    .createHmac('sha256', process.env.SHOPIFY_API_SECRET)
    .update(rawBody, 'utf8')
    .digest('base64');

  if (generated !== hmacHeader) {
    return res.status(401).json({ error: 'HMAC verification failed' });
  }
  next();
}

// ─── Webhooks GDPR (antes de protect, usan HMAC de Shopify) ──────────────────
router.post(
  '/webhooks/customer-data-request',
  verifyShopifyWebhook,
  shopifyCtrl.customerDataRequest,
);
router.post(
  '/webhooks/customer-data-erasure',
  verifyShopifyWebhook,
  shopifyCtrl.customerDataErasure,
);
router.post(
  '/webhooks/shop-data-erasure',
  verifyShopifyWebhook,
  shopifyCtrl.shopDataErasure,
);

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

// ─── Órdenes ─────────────────────────────────────────────────────────────────
router.get('/orders', checkPlanActivo, shopifyCtrl.listar_ordenes);

module.exports = router;
