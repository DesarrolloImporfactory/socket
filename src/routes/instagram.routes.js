const express = require('express');
const router = express.Router();

const igWebhookController = require('../controllers/instagram_webhook.controller');
const igOauthController = require('../controllers/instagram_oauth.controller');
const verifyFBSignature = require('../middlewares/verifyFacebookSignature.middleware');

const SECRET_IG_GRAPH = 'b9015cadee33d57d360fe133812bfce0';

const igController = require('../controllers/instagram.controller');
const igConversations = require('../controllers/instagram_conversations.controller');
// ────────────────────────────────────────────────────────────────
//  WEBHOOK IG (object === "instagram")
// GET: verificación (hub.challenge)
// POST: recepción de eventos (validando firma X-Hub-Signature-256)
// ────────────────────────────────────────────────────────────────
router.get('/webhook', igWebhookController.verifyWebhook);

router.post(
  '/webhook',
  (req, res, next) => {
    req.fbAppSecretOverride = SECRET_IG_GRAPH;
    next();
  },
  verifyFBSignature,
  igWebhookController.receiveWebhook
);

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

router.get('/conversations', igConversations.listConversations);
router.get('/conversations/:id/messages', igConversations.listMessages);
module.exports = router;
