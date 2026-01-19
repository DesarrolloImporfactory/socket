const express = require('express');
const router = express.Router();

const igController = require('../controllers/instagram.controller');
const igOauthController = require('../controllers/instagram_oauth.controller');
const verifyFBSignature = require('../middlewares/verifyFacebookSignature.middleware');
const igConversations = require('../controllers/instagram_conversations.controller');

/* =============================
   Helpers de gate / debug
============================= */
const seen = new Set();
const seenOnce = (key, ttl = 5 * 60 * 1000) => {
  if (!key) return false;
  if (seen.has(key)) return true;
  seen.add(key);
  setTimeout(() => seen.delete(key), ttl);
  return false;
};

const safeJSON = (obj, max = 3000) => {
  try {
    const s = JSON.stringify(obj, null, 2);
    return s.length > max ? s.slice(0, max) + '…[truncado]' : s;
  } catch {
    return String(obj);
  }
};

const summarize = (m) => {
  const msg = m.message || {};
  const kind = msg.text
    ? 'message_text'
    : m.message_edit
      ? 'message_edit'
      : m.delivery
        ? 'delivery'
        : m.read
          ? 'read'
          : m.postback
            ? 'postback'
            : m.reaction
              ? 'reaction'
              : 'unknown';

  return {
    kind,
    mid: msg.mid || m.postback?.mid || null,
    is_echo: !!msg.is_echo,
    sender: m.sender?.id,
    recipient: m.recipient?.id,
    timestamp: m.timestamp,
    text: msg.text || null,
    attachments: Array.isArray(msg.attachments)
      ? msg.attachments.map((a) => a.type)
      : [],
  };
};

router.get('/webhook', igController.verifyWebhook);

router.post(
  '/webhook',
  (req, res, next) => {
    try {
      // Debug de entrada
      console.log('[IG ROUTES][INCOMING BODY]', safeJSON(req.body, 1500));

      const entry = req.body?.entry?.[0];
      const messaging = entry?.messaging?.[0];

      if (!messaging) {
        console.log(
          '[IG ROUTES][NO-MESSAGING] body=',
          safeJSON(req.body, 1000),
        );
        return next();
      }

      const isEcho = messaging?.message?.is_echo === true;
      const isEdit = !!messaging?.message_edit;

      const mid = messaging?.message?.mid;
      const key =
        mid ||
        `${messaging?.sender?.id}:${messaging?.timestamp}:${
          isEdit ? 'edit' : 'msg'
        }`;

      // Resumen siempre (primera vez)
      if (!seenOnce(key)) {
        console.log('[IG ROUTES][SUMMARY]', summarize(messaging));
        // RAW util para inspección rápida de este evento
        console.log('[IG ROUTES][RAW messaging]', safeJSON(messaging, 2000));
      } else {
        console.log('[IG ROUTES][DUPLICATE]', { key });
        return res.sendStatus(200);
      }

      // Edit sigue ignorado, pero el eco pasa al controller
      if (isEdit) {
        console.log('[IG ROUTES][IGNORED EDIT]', { mid: mid || null });
        return res.sendStatus(200);
      }

      // Pasa info útil al controller (incluye eco)
      req.gate = {
        text: messaging?.message?.text || null,
        mid,
        sender: messaging?.sender?.id,
        recipient: messaging?.recipient?.id,
        timestamp: messaging?.timestamp,
        is_echo: isEcho,
      };
      return next();
    } catch (e) {
      console.error('[IG ROUTES][GATE ERROR]', e.message);
      return next();
    }
  },
  verifyFBSignature,
  igController.receiveWebhook,
);

// OAuth / conexión
router.get('/facebook/login-url', igOauthController.getLoginUrl);
router.post('/facebook/oauth/exchange', igOauthController.exchangeCode);
router.get('/facebook/pages', igOauthController.listUserPages);
router.post('/facebook/connect', igOauthController.connectPage);

// Lecturas IG
router.get('/conversations', igConversations.listConversations);
router.get('/conversations/:id/messages', igConversations.listMessages);

// listar conexiones IG por id_configuracion
router.get('/connections', igController.listConnections);

module.exports = router;
