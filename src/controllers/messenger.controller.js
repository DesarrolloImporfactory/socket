const AppError = require('../utils/appError');
const catchAsync = require('../utils/catchAsync');

// Importa tus servicios existentes
const MessengerService = require('../services/messenger.service'); // tu router de Messenger (si lo tienes)
const InstagramService = require('../services/instagram.service'); // ya existe en tu proyecto

exports.verifyWebhook = (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === process.env.FB_VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.status(403).send('Forbidden');
};

exports.receiveWebhook = catchAsync(async (req, res, next) => {
  const body = req.body;

  if (body.object !== 'page') {
    // Importante: los DMs IG **no** vienen por object=instagram
    console.log('[PAGE_WEBHOOK] object != page → se ignora', body.object);
    return res.sendStatus(200);
  }

  console.log(
    '[PAGE_WEBHOOK][RAW] entries=',
    Array.isArray(body.entry) ? body.entry.length : 0
  );

  await Promise.all(
    (body.entry || []).map(async (entry) => {
      const messaging = entry.messaging || [];
      if (!messaging.length) {
        console.log('[PAGE_WEBHOOK] entry sin messaging[]');
        return;
      }
      for (const event of messaging) {
        const product = event.messaging_product || 'facebook'; // Meta suele setear 'instagram' o 'facebook'
        const isIG = product === 'instagram';

        // Logs útiles
        console.log('[PAGE_WEBHOOK][EVENT]', {
          product,
          page_id: event.recipient?.id,
          sender: event.sender?.id,
          hasMessage: !!event.message,
          hasPostback: !!event.postback,
          hasRead: !!event.read,
          hasDelivery: !!event.delivery,
        });

        // Ruteo por producto
        if (isIG) {
          // 👉 Usa tu InstagramService existente (el que guarda en DB y emite sockets)
          try {
            await InstagramService.routeEvent(event);
          } catch (e) {
            console.error(
              '[IG ROUTE_EVENT ERROR]',
              e?.response?.data || e.message
            );
          }
        } else {
          // Messenger “normal”
          try {
            await MessengerService.routeEvent?.(event);
          } catch (e) {
            console.error(
              '[MS ROUTE_EVENT ERROR]',
              e?.response?.data || e.message
            );
          }
        }
      }
    })
  );

  return res.sendStatus(200);
});
