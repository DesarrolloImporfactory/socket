const AppError = require('../utils/appError');
const catchAsync = require('../utils/catchAsync');
const InstagramService = require('../services/instagram.service');

function safeParseJson(raw) {
  if (!raw) return null;
  if (Buffer.isBuffer(raw)) {
    try {
      return JSON.parse(raw.toString('utf8'));
    } catch {
      return null;
    }
  }
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (typeof raw === 'object') return raw;
  return null;
}

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
  // 1) parsea crudo -> JSON
  const body = safeParseJson(req.body);
  if (!body) {
    console.warn('[IG_WEBHOOK] body vacío o no JSON');
    return res.sendStatus(200);
  }

  // 2) logs base
  console.log(
    '[IG_WEBHOOK][RAW].object=',
    body.object,
    'entries=',
    body.entry?.length || 0
  );

  // IG (messaging) viene con object="page"
  if (body.object !== 'page') {
    console.info(
      '[IG_WEBHOOK] object != page (se ignora). object=',
      body.object
    );
    return res.sendStatus(200);
  }

  // 3) recorre entries
  for (const entry of body.entry || []) {
    // IG y Messenger suelen usar "messaging"; con Handover puede llegar "standby"
    const events = entry.messaging || entry.standby || [];

    console.log('[IG_WEBHOOK][ENTRY]', {
      id: entry.id,
      time: entry.time,
      hasMessaging: !!entry.messaging,
      hasStandby: !!entry.standby,
      count: events.length,
    });

    for (const event of events) {
      // Log mínimo por evento
      console.log('[IG_WEBHOOK][EVENT]', {
        messaging_product: event.messaging_product,
        sender: event.sender?.id,
        recipient: event.recipient?.id,
        hasMessage: !!event.message,
        hasPostback: !!event.postback,
        hasRead: !!event.read,
        hasDelivery: !!event.delivery,
      });

      // TIP: durante pruebas no abortes si falta messaging_product; solo loguéalo
      if (!event.messaging_product) {
        console.warn(
          '[IG_WEBHOOK] evento sin messaging_product; continúo por debug'
        );
      }

      try {
        await InstagramService.routeEvent(event);
      } catch (e) {
        console.error(
          '[IG_WEBHOOK][routeEvent][ERROR]',
          e?.response?.data || e.message
        );
      }
    }
  }

  // 4) siempre 200 rápido
  return res.sendStatus(200);
});
