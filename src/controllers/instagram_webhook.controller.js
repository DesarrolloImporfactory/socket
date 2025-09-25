const catchAsync = require('../utils/catchAsync');

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
    console.log('[IG_WEBHOOK] object != instagram →', body.object);
    return res.sendStatus(200);
  }

  console.log(
    '[IG_WEBHOOK][RAW] object=',
    body.object,
    'entries=',
    body.entry?.length || 0
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

    // Ignora el “Enviar a mi servidor” del panel (datos falsos)
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

    // Por ahora solo log; si quieres procesar comments/mentions en el futuro, hazlo aquí.
    for (const ch of changes) {
      console.log('[IG_WEBHOOK][CHANGE]', ch.field, JSON.stringify(ch.value));
    }
  }

  return res.sendStatus(200);
});
