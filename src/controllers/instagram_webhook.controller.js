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
 */
exports.receiveWebhook = catchAsync(async (req, res) => {
  const body = req.body || {};

  //Caso normal de Ig Messasging object === instagram
  if (body.object === 'instagram') {
    for (const entry of body.entry || []) {
      const event = entry.messaging || entry.standby || [];
      for (const event of events) {
        if (
          event.messaging_product &&
          event.messaging_product !== 'instagram'
        ) {
          continue;
        }
        try {
          await InstagramService.routeEvent(event);
        } catch (err) {
          console.error(
            '[IG receive Webhook][routerEvent error]',
            err?.message || err
          );
        }
      }
    }
    return res.sendStatus(200);
  }

  // 2) Tolerancia: algunos entornos pueden seguir enviando bajo object=page con messaging_product='instagram'
  if (body.object === 'page') {
    for (const entry of body.entry || []) {
      const events = entry.messaging || entry.standby || [];
      for (const event of events) {
        if (event.messaging_product === 'instagram') {
          try {
            await InstagramService.routeEvent(event);
          } catch (err) {
            console.error(
              '[IG receiveWebhook][routeEvent error(page)]',
              err?.message || err
            );
          }
        }
      }
    }
    return res.sendStatus(200);
  }

  // 3) Ignora silenciosamente (pero sin 4xx) para no provocar reintentos
  console.info('[IG Webhook] Ignorado: object no soportado =>', body.object);
  return res.status(200).send('ignored');
});
