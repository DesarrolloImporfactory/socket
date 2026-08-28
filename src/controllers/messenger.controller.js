const AppError = require('../utils/appError');
const catchAsync = require('../utils/catchAsync');

// Importa tus servicios existentes
const MessengerService = require('../services/messenger.service');
const InstagramService = require('../services/instagram.service');
const FacebookComments = require('../services/facebook_comments.service');

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

      // Comentarios de publicaciones: llegan en entry.changes[], no en
      // messaging[]. Va ANTES del early-return de abajo porque un entry de
      // `feed` no trae messaging ni standby y se descartaba entero.
      //
      // Se aísla en su propio try: un fallo guardando un comentario no debe
      // hacer que Meta reintente el entry completo y se reprocesen los
      // mensajes de Messenger que venían en el mismo lote.
      if (entry.changes && entry.changes.length) {
        // Traza cruda ANTES de filtrar nada. Sin esto no hay forma de
        // distinguir "Meta no mandó el evento" de "llegó y lo descartamos",
        // que es justo la duda al depurar la suscripción del webhook.
        console.log(
          '[FB_FEED][RAW]',
          JSON.stringify({
            page_id: entry.id,
            cambios: entry.changes.map((c) => ({
              field: c.field,
              item: c.value?.item,
              verb: c.value?.verb,
            })),
          }),
        );

        for (const change of entry.changes) {
          try {
            await FacebookComments.procesarCambioFeed(entry.id, change);
          } catch (err) {
            // console.error va a stderr → chatapi-error.log, no a -out.log.
            console.error('[FB_FEED][ERROR]', err.message);
          }
        }
      }

      if (!events.length) {
        if (!entry.changes?.length) {
          console.log('[PAGE_WEBHOOK] entry sin messaging/standby[]');
        }
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
    }),
  );

  return res.sendStatus(200);
});
