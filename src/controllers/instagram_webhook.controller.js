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

exports.receiveWebhook = catchAsync(async (req, res) => {
  const body = req.body;
  if (!body || typeof body !== 'object') {
    console.warn('[IG_WEBHOOK] body vacío o inválido');
    return res.sendStatus(200);
  }

  if (body.object !== 'instagram') {
    // Este endpoint es SOLO para IG Graph; cualquier otro object se ignora
    console.log('[IG_WEBHOOK] object != instagram →', body.object);
    return res.sendStatus(200);
  }

  console.log(
    '[IG_WEBHOOK][RAW] object=',
    body.object,
    'entries=',
    Array.isArray(body.entry) ? body.entry.length : 0
  );

  for (const entry of body.entry || []) {
    const igId = String(entry.id || '');
    const changes = entry.changes || [];

    console.log(
      '[IG_WEBHOOK][INSTAGRAM] entry.id (ig_id)=',
      igId,
      'changes=',
      changes.length
    );

    // Ignora payloads de muestra del panel (ej. igId "0" y sender/recipient de demo)
    const isSample =
      igId === '0' ||
      changes.some(
        (c) =>
          c?.field === 'messages' &&
          c?.value?.sender?.id === '12334' &&
          c?.value?.recipient?.id === '23245'
      );

    if (isSample) {
      console.log('[IG_WEBHOOK] sample payload ignorado');
      continue;
    }

    // Si en el futuro quieres procesar eventos reales de IG Graph, hazlo aquí.
    // Nota: Los DMs IG normales ya llegan por /api/v1/messenger/webhook (object: "page").
    for (const ch of changes) {
      console.log('[IG_WEBHOOK][CHANGE]', ch.field, JSON.stringify(ch.value));
      // Ejemplos de fields: 'comments', 'mentions', 'messages', 'message_reactions', etc.
      // (De momento solo logueamos para no alterar tu flujo actual).
    }
  }

  return res.sendStatus(200);
});
