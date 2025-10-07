const catchAsync = require('../utils/catchAsync');
const AppError = require('../utils/appError');
const TikTokWebhookService = require('../services/tiktok_webhook.service');

/**
 * GET /api/v1/tiktok/webhook/verify
 * Verifica el webhook de TikTok (challenge verification)
 */
exports.verifyWebhook = (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  console.log('[TIKTOK_WEBHOOK] Verificación de webhook:', {
    mode,
    token,
    challenge,
  });

  // Verificar que es una petición de suscripción válida
  if (
    mode === 'subscribe' &&
    token === process.env.TIKTOK_WEBHOOK_VERIFY_TOKEN
  ) {
    console.log('[TIKTOK_WEBHOOK] Webhook verificado exitosamente');
    return res.status(200).send(challenge);
  }

  console.log('[TIKTOK_WEBHOOK] Verificación de webhook fallida');
  return res.status(403).send('Forbidden');
};

/**
 * POST /api/v1/tiktok/webhook/receive
 * Recibe eventos del webhook de TikTok
 */
exports.receiveWebhook = catchAsync(async (req, res) => {
  const body = req.body;

  console.log(
    '[TIKTOK_WEBHOOK] Evento recibido:',
    JSON.stringify(body, null, 2)
  );

  // Validar estructura básica del webhook
  if (!body || !body.data) {
    console.log('[TIKTOK_WEBHOOK] Estructura de webhook inválida');
    return res.sendStatus(400);
  }

  try {
    // Procesar eventos según el tipo
    await TikTokWebhookService.processWebhookEvent(body);

    // Responder con 200 para confirmar recepción
    res.sendStatus(200);
  } catch (error) {
    console.error('[TIKTOK_WEBHOOK] Error procesando evento:', error);
    // Aún así responder con 200 para evitar reenvíos
    res.sendStatus(200);
  }
});

/**
 * POST /api/v1/tiktok/webhook/subscribe
 * Suscribe a eventos de webhook para una cuenta específica
 */
exports.subscribeWebhook = catchAsync(async (req, res, next) => {
  const { id_configuracion, event_types, callback_url } = req.body;

  if (!id_configuracion || !event_types || !callback_url) {
    return next(
      new AppError(
        'id_configuracion, event_types y callback_url son requeridos',
        400
      )
    );
  }

  const subscription = await TikTokWebhookService.subscribeToEvents({
    id_configuracion,
    event_types,
    callback_url,
  });

  res.json({
    ok: true,
    subscription,
    message: 'Suscripción a webhook creada exitosamente',
  });
});

/**
 * GET /api/v1/tiktok/webhook/subscriptions?id_configuracion=123
 * Lista las suscripciones de webhook activas
 */
exports.getSubscriptions = catchAsync(async (req, res, next) => {
  const { id_configuracion } = req.query;

  if (!id_configuracion) {
    return next(new AppError('id_configuracion es requerido', 400));
  }

  const subscriptions = await TikTokWebhookService.getSubscriptions(
    id_configuracion
  );

  res.json({
    ok: true,
    subscriptions,
  });
});

/**
 * DELETE /api/v1/tiktok/webhook/unsubscribe
 * Cancela una suscripción de webhook
 */
exports.unsubscribeWebhook = catchAsync(async (req, res, next) => {
  const { id_configuracion, subscription_id } = req.body;

  if (!id_configuracion || !subscription_id) {
    return next(
      new AppError('id_configuracion y subscription_id son requeridos', 400)
    );
  }

  await TikTokWebhookService.unsubscribeFromEvents({
    id_configuracion,
    subscription_id,
  });

  res.json({
    ok: true,
    message: 'Suscripción cancelada exitosamente',
  });
});

/**
 * GET /api/v1/tiktok/webhook/events?id_configuracion=123
 * Obtiene el historial de eventos de webhook recibidos
 */
exports.getWebhookEvents = catchAsync(async (req, res, next) => {
  const { id_configuracion, limit = 50, page = 1, event_type } = req.query;

  if (!id_configuracion) {
    return next(new AppError('id_configuracion es requerido', 400));
  }

  const events = await TikTokWebhookService.getWebhookEvents({
    id_configuracion,
    limit: parseInt(limit),
    page: parseInt(page),
    event_type,
  });

  res.json({
    ok: true,
    events: events.data,
    pagination: events.pagination,
  });
});

/**
 * POST /api/v1/tiktok/webhook/test
 * Envía un evento de prueba para verificar el webhook
 */
exports.testWebhook = catchAsync(async (req, res, next) => {
  const { id_configuracion, callback_url } = req.body;

  if (!id_configuracion || !callback_url) {
    return next(
      new AppError('id_configuracion y callback_url son requeridos', 400)
    );
  }

  const testResult = await TikTokWebhookService.sendTestEvent({
    id_configuracion,
    callback_url,
  });

  res.json({
    ok: true,
    test_result: testResult,
    message: 'Evento de prueba enviado',
  });
});
