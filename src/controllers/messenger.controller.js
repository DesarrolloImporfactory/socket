// controllers/messenger.controller.js
const AppError = require('../utils/appError');
const catchAsync = require('../utils/catchAsync');
const MessengerService = require('../services/messenger.service');

exports.verifyWebhook = (req, res, next) => {
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
    return next(new AppError('Evento no soportado(no es object=page)', 400));
  }

  await Promise.all(
    body.entry.map(async (entry) => {
      const events = entry.messaging || [];
      for (const event of events) {
        // Log compacto por evento entrante
        const pageId = event.recipient?.id;
        const senderPsid = event.sender?.id;
        const mid = event.message?.mid;
        const text = event.message?.text;
        console.log('[WEBHOOK_IN]', {
          pageId,
          senderPsid,
          mid,
          text: text || '(no-text)',
        });

        await MessengerService.routeEvent(event);
      }
    })
  );

  return res.sendStatus(200);
});
