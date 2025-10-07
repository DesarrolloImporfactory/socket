// controllers/instagram.controller.js
const AppError = require('../utils/appError');
const catchAsync = require('../utils/catchAsync');
const InstagramService = require('../services/instagram.service');

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
    return next(new AppError('Evento no soportado (object != page)', 400));
  }

  await Promise.all(
    body.entry.map(async (entry) => {
      const events = entry.messaging || [];
      for (const event of events) {
        const mp = event.messaging_product; // 'instagram' | 'facebook'
        if (mp === 'instagram') {
          await InstagramService.routeEvent(event);
        }
      }
    })
  );

  return res.sendStatus(200);
});
