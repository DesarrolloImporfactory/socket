const express = require('express');
const router = express.Router();

const igWebhookController = require('../controllers/instagram_webhook.controller');
const igOauthController = require('../controllers/instagram_oauth.controller');
const verifyFBSignature = require('../middlewares/verifyFacebookSignature.middleware');
const igConversations = require('../controllers/instagram_conversations.controller');

const SECRET_MESSENGER = '9cf575fae8f0516fa727623007cd8044'; // IMPORCHAT (Messenger)
const SECRET_IG_GRAPH = 'b9015cadee33d57d360fe133812bfce0'; // IMPORCHAT-IG (Instagram Graph)

router.get('/webhook', igWebhookController.verifyWebhook);

router.post(
  '/webhook',
  (req, res, next) => {
    try {
      if (req.body.entry?.[0]?.messaging.message.text) {
        console.log('[IG]: Getting request for Instagram Webhook');
        console.log(
          '[IG]: mensaje - en instagram',
          req.body.entry?.[0]?.messaging
        );
      } else {
        throw new Error('No messaging in body');
      }
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

      const tryMessenger = SECRET_MESSENGER ? hmac(SECRET_MESSENGER) : '';
      const tryIG = SECRET_IG_GRAPH ? hmac(SECRET_IG_GRAPH) : '';

      if (tryMessenger === theirHash) {
        req.fbAppSecretOverride = SECRET_MESSENGER;
        req.signatureVerified = true; // 👈 marcar verificado
        console.error('[IG GATE] ✅ MATCH IMPORCHAT (Messenger App)');
        return next();
      }
      if (tryIG === theirHash) {
        req.fbAppSecretOverride = SECRET_IG_GRAPH;
        req.signatureVerified = true; // 👈 marcar verificado
        console.error('[IG GATE] ✅ MATCH IMPORCHAT-IG (Instagram App)');
        return next();
      }

      console.error('[IG GATE] ❌ NO MATCH', {
        theirHash,
        tryMessenger: tryMessenger.slice(0, 16) + '…',
        tryIG: tryIG.slice(0, 16) + '…',
      });
      return res.status(401).send('Invalid signature');
    } catch (e) {
      console.error('[IG GATE] error', e.message);
      return res.status(500).send('Gate error');
    }
  },
  // deja el verify, pero permitirá bypass si ya fue verificado por el gate
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
