const express = require('express');
const router = express.Router();
const verifyShopifyWebhook = require('../middlewares/verifyShopifyWebhook');
const shopifyController = require('../controllers/shopifyCarritosController');

/* Webhook: orders/create → marca carritos abandonados como recuperados */
router.post(
  '/orders-create',
  verifyShopifyWebhook,
  shopifyController.handleOrderCreate,
);

/* Webhook: draft_orders/create → captura abandonos de Releasit COD Form */
router.post(
  '/abandoned-draft',
  verifyShopifyWebhook,
  shopifyController.handleAbandonedDraft,
);

router.post('/debug', shopifyController.handleDebugWebhook);

module.exports = router;
