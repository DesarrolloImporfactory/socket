const express = require('express');
const router = express.Router();

const igWebhookController = require('../controllers/instagram_webhook.controller');
const igOauthController = require('../controllers/instagram_oauth.controller');
const verifyFBSignature = require('../middlewares/verifyFacebookSignature.middleware');

// ────────────────────────────────────────────────────────────────
// WEBHOOK (objeto "page", igual que Messenger)
// GET: verificación (hub.challenge)
// POST: recepción de eventos (validando firma X-Hub-Signature-256)
// ────────────────────────────────────────────────────────────────
router.get('/webhook', igWebhookController.verifyWebhook);
router.post('/webhook', verifyFBSignature, igWebhookController.receiveWebhook);

// ────────────────────────────────────────────────────────────────
// OAUTH CON FACEBOOK (mismo flujo que Messenger)
// 1) Obtener URL de login (con scopes IG)
// 2) Intercambiar code → user access token largo + crear sesión OAuth
// 3) Listar páginas disponibles desde la sesión OAuth
// 4) Conectar página (suscribir webhooks + guardar page_token + IG info)
// ────────────────────────────────────────────────────────────────
router.get('/facebook/login-url', igOauthController.getLoginUrl);
router.post('/facebook/oauth/exchange', igOauthController.exchangeCode);
router.get('/facebook/pages', igOauthController.listUserPages);
router.post('/facebook/connect', igOauthController.connectPage);

module.exports = router;
