const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/dropi_webhook.controller');

router.post('/orders', ctrl.dropiOrdersWebhook);

module.exports = router;
