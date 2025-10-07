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
      // Solo IG
      if (event.messaging_product !== 'instagram') continue;

      // Descarta ecos / edits (el gate ya lo hizo, pero por seguridad)
      if (event.message?.is_echo) continue;
      if (event.message_edit) continue;

      // Solo routear lo que te interesa (message y/o postback)
      if (event.message || event.postback || event.read || event.delivery) {
        await InstagramService.routeEvent(event);
      }
    }
  }

  return res.sendStatus(200);
});
