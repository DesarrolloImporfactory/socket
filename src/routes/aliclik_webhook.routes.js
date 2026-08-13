const express = require('express');

const router = express.Router();

const aliclikWebhook = require('../controllers/aliclik_webhook.controller');

// Sin auth.protect: lo llama Aliclik, no un usuario logueado. La autenticación
// es el secreto del path, que además identifica a qué cuenta pertenece el
// evento (ver aliclik_webhook.controller.js).
router.post('/orders/:secret', aliclikWebhook.aliclikOrdersWebhook);

module.exports = router;
