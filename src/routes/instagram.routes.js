const express = require('express');
const router = express.Router();

const igWebhookController = require('../controllers/instagram_webhook.controller');
const igOauthController = require('../controllers/instagram_oauth.controller');
const verifyFBSignature = require('../middlewares/verifyFacebookSignature.middleware');
const igConversations = require('../controllers/instagram_conversations.controller');

router.get('/webhook', igWebhookController.verifyWebhook);

const seen = new Set();
const seenOnce = (key, ttl = 5 * 60 * 1000) => {
  if (!key) return false;
  if (seen.has(key)) return true;
  seen.add(key);
  setTimeout(() => seen.delete(key), ttl);
  return false;
};

router.post(
  '/webhook',
  (req, res, next) => {
    try {
      const entry = req.body?.entry?.[0];
      const messaging = entry?.messaging?.[0];

      if (!messaging) return next();

      const msg = messaging.message;
      const isEcho = msg?.is_echo === true;
      const isEdit = Boolean(messaging?.message_edit);

      // 🔇 Silenciar ecos y ediciones
      if (isEcho || isEdit) return res.sendStatus(200);

      // 🔒 Idempotencia por mid (fallback: sender+timestamp)
      const mid = msg?.mid;
      const key = mid || `${messaging?.sender?.id}:${messaging?.timestamp}`;
      if (seenOnce(key)) return res.sendStatus(200);

      const text = msg?.text;
      if (text) console.log('[IG GATE] Incoming IG Webhook', { message: text });

      req.gate = { text, messaging, entry };
      return next();
    } catch (e) {
      return next();
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
