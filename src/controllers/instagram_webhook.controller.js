const AppError = require('../utils/appError');
const catchAsync = require('../utils/catchAsync');
const InstagramService = require('../services/instagram.service');

/**
 * GET /api/v1/instagram/webhook
 * Verificación de webhook (hub.challenge)
 */
exports.verifyWebhook = (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === process.env.FB_VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.status(403).send('Forbidden');
};

/**
 * POST /api/v1/instagram/webhook
 * Recepción de eventos (firma ya validada por verifyFacebookSignature)
 *
 * Importante: Para IG Messaging, Meta envía eventos como object "page" y
 * dentro de entry.messaging[] (similar a Messenger).
 */
exports.receiveWebhook = catchAsync(async (req, res, next) => {
  const body = req.body;

  if (body.object !== 'page') {
    return next(new AppError('Evento no soportado (object != page)', 400));
  }

  await Promise.all(
    body.entry.map(async (entry) => {
      // IG y Messenger llegan ambos bajo "entry.messaging"
      const events = entry.messaging || [];

      for (const event of events) {
        const pageId = event.recipient?.id;
        const senderId = event.sender?.id; // En IG es el IGSID del usuario
        const mid = event.message?.mid;
        const text = event.message?.text;

        console.log('[IG_WEBHOOK_IN]', {
          pageId,
          senderId,
          mid,
          text: text || '(no-text)',
          isEcho: !!event.message?.is_echo,
          postback: event.postback?.payload,
        });

        // Delegar al servicio para enrutar: mensajes, postbacks, etc.
        await InstagramService.routeEvent(event);
      }
    })
  );

  return res.sendStatus(200);
});
