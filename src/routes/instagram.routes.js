const express = require('express');
const router = express.Router();

const igWebhookController = require('../controllers/instagram_webhook.controller');
const igOauthController = require('../controllers/instagram_oauth.controller');
const verifyFBSignature = require('../middlewares/verifyFacebookSignature.middleware');

const SECRET_MESSENGER = '9cf575fae8f0516fa727623007cd8044';
const SECRET_IG_GRAPH = 'b9015cadee33d57d360fe133812bfce0';

const igController = require('../controllers/instagram.controller');
const igConversations = require('../controllers/instagram_conversations.controller');
// ────────────────────────────────────────────────────────────────
//  WEBHOOK IG (object === "instagram")
// GET: verificación (hub.challenge)
// POST: recepción de eventos (validando firma X-Hub-Signature-256)
// ────────────────────────────────────────────────────────────────
router.get('/webhook', igWebhookController.verifyWebhook);

// POST con “gate” de firma + verificación final
router.post(
  '/webhook',
  // 1) este endpoint ya tiene express.json({verify}) montado a nivel app y pone req.rawBody
  // 2) gate: detecta qué secret matchea y fija req.fbAppSecretOverride
  (req, res, next) => {
    try {
      const sig = req.get('x-hub-signature-256');
      if (!sig) return res.status(401).send('Missing X-Hub-Signature-256');

      const [algo, theirHash] = sig.split('=');
      if (algo !== 'sha256' || !theirHash)
        return res.status(401).send('Invalid signature algorithm');

      if (!req.rawBody || !Buffer.isBuffer(req.rawBody)) {
        console.error('[IG GATE] rawBody missing/not Buffer');
        return res.status(401).send('Invalid signature (no raw body)');
      }

      const crypto = require('crypto');
      const hmac = (secret) =>
        crypto.createHmac('sha256', secret).update(req.rawBody).digest('hex');

      const h1 = SECRET_MESSENGER ? hmac(SECRET_MESSENGER) : '';
      const h2 = SECRET_IG_GRAPH ? hmac(SECRET_IG_GRAPH) : '';

      if (h1 === theirHash) {
        req.fbAppSecretOverride = SECRET_MESSENGER;
        console.error('[IG GATE] ✅ MATCH IMPORCHAT (Messenger App)');
        return next();
      }
      if (h2 === theirHash) {
        req.fbAppSecretOverride = SECRET_IG_GRAPH;
        console.error('[IG GATE] ✅ MATCH IMPORCHAT-IG (Instagram App)');
        return next();
      }

      console.error('[IG GATE] ❌ NO MATCH', {
        theirHash,
        tryMessenger: h1.slice(0, 16) + '…',
        tryIG: h2.slice(0, 16) + '…',
      });
      return res.status(401).send('Invalid signature');
    } catch (e) {
      console.error('[IG GATE] error', e.message);
      return res.status(500).send('Gate error');
    }
  },

  // ahora sí, verifica formalmente usando el secret que fijó el gate:
  verifyFBSignature,

  // y pasa al controlador
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
