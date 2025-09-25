const express = require('express');
const router = express.Router();

const igWebhookController = require('../controllers/instagram_webhook.controller');
const igOauthController = require('../controllers/instagram_oauth.controller');
const verifyFBSignature = require('../middlewares/verifyFacebookSignature.middleware');
const igConversations = require('../controllers/instagram_conversations.controller');

const SECRET_MESSENGER = '9cf575fae8f0516fa727623007cd8044'; // App IMPORCHAT (Facebook/Messenger)
const SECRET_IG_GRAPH = 'b9015cadee33d57d360fe133812bfce0'; // App IMPORCHAT-IG (Instagram Graph)

router.get('/webhook', igWebhookController.verifyWebhook);

router.post(
  '/webhook',
  (req, res, next) => {
    try {
      const sig = req.get('x-hub-signature-256');
      if (!sig) return res.status(401).send('Missing X-Hub-Signature-256');

      const [algo, theirHash] = sig.split('=');
      if (algo !== 'sha256' || !theirHash) {
        return res.status(401).send('Invalid signature algorithm');
      }
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
  verifyFBSignature,
  igWebhookController.receiveWebhook
);

// OAuth / conexión
router.get('/facebook/login-url', igOauthController.getLoginUrl);
router.post('/facebook/oauth/exchange', igOauthController.exchangeCode);
router.get('/facebook/pages', igOauthController.listUserPages);
router.post('/facebook/connect', igOauthController.connectPage);

// Lecturas IG
router.get('/conversations', igConversations.listConversations);
router.get('/conversations/:id/messages', igConversations.listMessages);

module.exports = router;
