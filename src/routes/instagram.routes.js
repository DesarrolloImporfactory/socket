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
      let message = '';
      if (req.body.entry?.[0]?.messaging[0]?.message?.text) {
        message = req.body.entry[0].messaging[0].message.text;
      } else {
        throw new Error('No messaging in body');
      }

      console.log('[IG GATE] Incoming request for IG Webhook', { message });
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
