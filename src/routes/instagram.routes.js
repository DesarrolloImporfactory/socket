const express = require('express');
const router = express.Router();

const igWebhookController = require('../controllers/instagram_webhook.controller');
const igOauthController = require('../controllers/instagram_oauth.controller');
const verifyFBSignature = require('../middlewares/verifyFacebookSignature.middleware');
const igConversations = require('../controllers/instagram_conversations.controller');

router.get('/webhook', igWebhookController.verifyWebhook);

// ===== helpers (arriba del archivo, una sola vez) =====
const seen = new Set();
const seenOnce = (key, ttl = 5 * 60 * 1000) => {
  if (!key) return false;
  if (seen.has(key)) return true;
  seen.add(key);
  setTimeout(() => seen.delete(key), ttl);
  return false;
};

const safeJSON = (obj, max = 4000) => {
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

// ===== ruta =====
router.post(
  '/webhook',
  (req, res, next) => {
    try {
      const entry = req.body?.entry?.[0];
      const messaging = entry?.messaging?.[0];

      // Si no hay "messaging", log corto del body y seguir
      if (!messaging) {
        console.log('[IG GATE][NO-MESSAGING] body=', safeJSON(req.body, 1500));
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

      // Deduplicación: si ya lo vimos, respondemos 200 y paramos
      if (seenOnce(key)) return res.sendStatus(200);

      // Siempre logueamos un resumen claro
      console.log('[IG GATE][SUMMARY]', summarize(messaging));

      // Y un dump truncado del objeto relevante (lo que usted quiere ver)
      // - Para mensajes normales: dump de "messaging"
      // - Para casos raros: si quiere ver TODO, cambie a req.body
      console.log('[IG GATE][RAW]', safeJSON(messaging, 3000));

      // Silenciar ecos y ediciones tras registrar (no procesar más)
      if (isEcho || isEdit) return res.sendStatus(200);

      // Para el controller (si le sirve)
      const text = messaging?.message?.text || null;
      req.gate = { text, messaging, entry };

      return next();
    } catch (e) {
      console.error('[IG GATE][ERROR]', e.message);
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
