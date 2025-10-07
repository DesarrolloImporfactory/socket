const express = require('express');
const router = express.Router();

const igWebhookController = require('../controllers/instagram_webhook.controller');
const igOauthController = require('../controllers/instagram_oauth.controller');
const verifyFBSignature = require('../middlewares/verifyFacebookSignature.middleware');
const igConversations = require('../controllers/instagram_conversations.controller');

router.get('/webhook', igWebhookController.verifyWebhook);

router.post(
  '/webhook',
  (req, res, next) => {
    try {
      const entry = req.body?.entry?.[0];
      const messaging = entry?.messaging?.[0];

      if (!messaging) {
        // Evento válido sin "messaging" (delivery/read/etc.). No es error.
        console.log('[IG GATE] evento sin "messaging" (ok)');
        return next();
      }

      const text = messaging?.message?.text;
      if (text) {
        console.log('[IG GATE] Incoming IG Webhook', { message: text });
      } else {
        // Muchos eventos no traen texto (eco, delivery, read, postback)
        console.log('[IG GATE] messaging sin texto (ok)', {
          keys: Object.keys(messaging),
        });
      }

      // Si quieres usarlo luego en el controller:
      req.gate = { text, messaging, entry };
      return next();
    } catch (e) {
      console.error('[IG GATE] error', e.message);
      // ¡No devuelvas 5xx! Deja seguir para que el controller responda 200.
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
