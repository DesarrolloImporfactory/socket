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

exports.receiveWebhook = catchAsync(async (req, res) => {
  const body = req.body;
  if (body.object !== 'page') {
    console.log('[PAGE_WEBHOOK] object != page → se ignora', body.object);
    console.log('jeimy was here!');
    console.log('Otra línea de log para verificar el flujo');
    console.log('Otra línea de log para verificar el flujo');
    console.log('Otra línea de log para verificar el flujo');
    console.log('Otra línea de log para verificar el flujo');
    console.log('Otra línea de log para verificar el flujo');
    return res.sendStatus(200);
  }

  await Promise.all(
    (body.entry || []).map(async (entry) => {
      // 👇 Unificamos fuentes: messaging y standby
      const events =
        entry.messaging && entry.messaging.length
          ? entry.messaging
          : entry.standby && entry.standby.length
          ? entry.standby
          : [];

      if (!events.length) {
        console.log('[PAGE_WEBHOOK] entry sin messaging/standby[]');
        return;
      }

      for (const event of events) {
        const product = event.messaging_product || 'facebook';
        const isIG = product === 'instagram';

        console.log('[PAGE_WEBHOOK][EVENT]', {
          product,
          page_id: event.recipient?.id,
          sender: event.sender?.id,
          hasMessage: !!event.message,
          hasPostback: !!event.postback,
          hasRead: !!event.read,
          hasDelivery: !!event.delivery,
          // 👇 útil para diagnosticar handover
          fromStandby: !!entry.standby && entry.standby.length > 0,
        });

        if (isIG) {
          await InstagramService.routeEvent(event);
        } else {
          await MessengerService.routeEvent(event);
        }
      }
    })
  );

  return res.sendStatus(200);
});
