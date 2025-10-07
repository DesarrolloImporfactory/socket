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

/**
 * GET /api/v1/tiktok/webhook/logs
 * Obtiene logs detallados de webhooks con filtros
 */
exports.getWebhookLogs = catchAsync(async (req, res, next) => {
  const { TikTokWebhookLog } = require('../models/initModels');
  const {
    page = 1,
    limit = 50,
    hours = 24,
    isTikTok,
    isTest,
    statusCode,
    method = 'POST',
  } = req.query;

  const offset = (page - 1) * limit;
  const since = new Date(Date.now() - hours * 60 * 60 * 1000);

  const whereConditions = {
    received_at: {
      [require('sequelize').Op.gte]: since,
    },
    method: method.toUpperCase(),
  };

  if (isTikTok !== undefined) {
    whereConditions.is_tiktok_request = isTikTok === 'true';
  }

  if (isTest !== undefined) {
    whereConditions.is_test_request = isTest === 'true';
  }

  if (statusCode) {
    whereConditions.response_status = parseInt(statusCode);
  }

  const logs = await TikTokWebhookLog.findAll({
    where: whereConditions,
    order: [['received_at', 'DESC']],
    limit: parseInt(limit),
    offset: parseInt(offset),
  });

  const total = await TikTokWebhookLog.count({
    where: whereConditions,
  });

  res.json({
    ok: true,
    data: {
      logs,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / limit),
      },
      filters: {
        hours: parseInt(hours),
        isTikTok,
        isTest,
        statusCode,
        method,
      },
    },
  });
});

/**
 * GET /api/v1/tiktok/webhook/stats
 * Obtiene estadísticas detalladas de webhooks
 */
exports.getWebhookStats = catchAsync(async (req, res, next) => {
  const { TikTokWebhookLog } = require('../models/initModels');
  const { hours = 24 } = req.query;
  const since = new Date(Date.now() - hours * 60 * 60 * 1000);

  const baseWhere = {
    received_at: {
      [require('sequelize').Op.gte]: since,
    },
  };

  // Estadísticas generales
  const [
    totalRequests,
    tikTokRequests,
    testRequests,
    successfulRequests,
    errorRequests,
  ] = await Promise.all([
    TikTokWebhookLog.count({ where: baseWhere }),
    TikTokWebhookLog.count({
      where: { ...baseWhere, is_tiktok_request: true },
    }),
    TikTokWebhookLog.count({
      where: { ...baseWhere, is_test_request: true },
    }),
    TikTokWebhookLog.count({
      where: {
        ...baseWhere,
        response_status: { [require('sequelize').Op.between]: [200, 299] },
      },
    }),
    TikTokWebhookLog.count({
      where: {
        ...baseWhere,
        response_status: { [require('sequelize').Op.gte]: 400 },
      },
    }),
  ]);

  // Distribución por código de estado
  const statusDistribution = await TikTokWebhookLog.findAll({
    where: baseWhere,
    attributes: [
      'response_status',
      [require('sequelize').fn('COUNT', '*'), 'count'],
    ],
    group: ['response_status'],
    order: [['response_status', 'ASC']],
  });

  // Últimas 10 IPs que hicieron requests
  const topIPs = await TikTokWebhookLog.findAll({
    where: baseWhere,
    attributes: [
      'client_ip',
      [require('sequelize').fn('COUNT', '*'), 'count'],
      [
        require('sequelize').fn('MAX', require('sequelize').col('received_at')),
        'last_request',
      ],
    ],
    group: ['client_ip'],
    order: [[require('sequelize').fn('COUNT', '*'), 'DESC']],
    limit: 10,
  });

  // User Agents más comunes
  const topUserAgents = await TikTokWebhookLog.findAll({
    where: {
      ...baseWhere,
      user_agent: { [require('sequelize').Op.ne]: null },
    },
    attributes: [
      'user_agent',
      [require('sequelize').fn('COUNT', '*'), 'count'],
    ],
    group: ['user_agent'],
    order: [[require('sequelize').fn('COUNT', '*'), 'DESC']],
    limit: 5,
  });

  // Requests por hora (últimas horas)
  const hourlyStats = await TikTokWebhookLog.findAll({
    where: baseWhere,
    attributes: [
      [
        require('sequelize').fn(
          'DATE_FORMAT',
          require('sequelize').col('received_at'),
          '%Y-%m-%d %H:00:00'
        ),
        'hour',
      ],
      [require('sequelize').fn('COUNT', '*'), 'count'],
      [
        require('sequelize').fn(
          'SUM',
          require('sequelize').cast(
            require('sequelize').col('is_tiktok_request'),
            'UNSIGNED'
          )
        ),
        'tiktok_count',
      ],
      [
        require('sequelize').fn(
          'SUM',
          require('sequelize').cast(
            require('sequelize').col('is_test_request'),
            'UNSIGNED'
          )
        ),
        'test_count',
      ],
    ],
    group: [
      require('sequelize').fn(
        'DATE_FORMAT',
        require('sequelize').col('received_at'),
        '%Y-%m-%d %H:00:00'
      ),
    ],
    order: [['hour', 'DESC']],
    limit: parseInt(hours),
  });

  res.json({
    ok: true,
    data: {
      summary: {
        total_requests: totalRequests,
        tiktok_requests: tikTokRequests,
        test_requests: testRequests,
        successful_requests: successfulRequests,
        error_requests: errorRequests,
        success_rate:
          totalRequests > 0
            ? ((successfulRequests / totalRequests) * 100).toFixed(2)
            : 0,
        tiktok_detection_rate:
          totalRequests > 0
            ? ((tikTokRequests / totalRequests) * 100).toFixed(2)
            : 0,
      },
      status_distribution: statusDistribution,
      top_ips: topIPs,
      top_user_agents: topUserAgents,
      hourly_stats: hourlyStats.reverse(),
      period: {
        hours: parseInt(hours),
        from: since.toISOString(),
        to: new Date().toISOString(),
      },
    },
  });
});
