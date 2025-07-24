const AppError = require('../utils/appError');
const catchAsync = require('../utils/catchAsync');
const MessengerService = require('../services/messenger.service');

exports.verifyWebhook = (req, res, next) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === process.env.FB_VERIFY_TOKEN) {
    console.log('Webhook de Messenger Verificado correctamente');
    return res.status(200).send(challenge);
  }
  return res.status(403).send('Forbidden');
};

exports.receiveWebhook = catchAsync(async (req, res, next) => {
  const body = req.body;

  //Messenger envia object=page
  if (body.object !== 'page') {
    return next(new AppError('Evento no soportado(no es object=page)', 400));
  }

  //Procesamos cada entry
  await Promise.all(
    body.entry.map(async (entry) => {
      const events = entry.messaging || [];
      for (const event of events) {
        await MessengerService.routeEvent(event);
      }
    })
  );

  return res.sendStatus(200);
});
