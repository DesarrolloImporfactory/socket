const express = require('express');
const router = express.Router();
const verifyShopifyWebhook = require('../middlewares/verifyShopifyWebhook');
const shopifyController = require('../controllers/shopifyCarritosController');

router.post('/checkouts-create', verifyShopifyWebhook, shopifyController.handleCheckoutCreate);
router.post('/checkouts-update', verifyShopifyWebhook, shopifyController.handleCheckoutUpdate);
router.post('/checkouts-delete', verifyShopifyWebhook, shopifyController.handleCheckoutDelete);
router.post('/orders-create',    verifyShopifyWebhook, shopifyController.handleOrderCreate);

module.exports = router;