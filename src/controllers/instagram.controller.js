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
  if (!body || typeof body !== 'object') return res.sendStatus(200);

  if (body.object !== 'page' && body.object !== 'instagram') {
    return res.sendStatus(200);
  }

  // Procesa entradas
  for (const entry of body.entry || []) {
    const events = entry.messaging || [];
    for (const event of events) {
      try {
        await InstagramService.routeEvent(event);
      } catch (e) {
        console.warn('[IG CONTROLLER][routeEvent][WARN]', e.message);
      }
    }
  }

  return res.sendStatus(200);
});
