const crypto = require('crypto');
const TikTokWebhookService = require('../services/tiktok_webhook.service');
const AppError = require('../utils/appError');

/**
 * Middleware para validar la firma del webhook de TikTok
 * Este middleware debe aplicarse ANTES de express.json() para tener acceso al raw body
 */
exports.validateTikTokWebhookSignature = (req, res, next) => {
  // Solo validar si hay una clave secreta configurada
  if (!process.env.TIKTOK_WEBHOOK_SECRET) {
    console.log(
      '[TIKTOK_WEBHOOK] Advertencia: No hay TIKTOK_WEBHOOK_SECRET configurado'
    );
    return next();
  }

  const signature = req.headers['x-tiktok-signature'];

  if (!signature) {
    console.log('[TIKTOK_WEBHOOK] Firma faltante en webhook');
    return res.status(401).json({ error: 'Signature missing' });
  }

  let rawBody;
  if (req.rawBody) {
    rawBody = req.rawBody;
  } else if (req.body) {
    rawBody = JSON.stringify(req.body);
  } else {
    console.log('[TIKTOK_WEBHOOK] Body no disponible para validación');
    return res.status(400).json({ error: 'Body not available for validation' });
  }

  try {
    const isValid = TikTokWebhookService.validateWebhookSignature(
      rawBody,
      signature,
      process.env.TIKTOK_WEBHOOK_SECRET
    );

    if (!isValid) {
      console.log('[TIKTOK_WEBHOOK] Firma inválida');
      return res.status(401).json({ error: 'Invalid signature' });
    }

    console.log('[TIKTOK_WEBHOOK] Firma validada exitosamente');
    next();
  } catch (error) {
    console.error('[TIKTOK_WEBHOOK] Error validando firma:', error);
    return res.status(500).json({ error: 'Signature validation failed' });
  }
};

/**
 * Middleware para capturar el raw body para validación de firma
 */
exports.captureRawBody = (req, res, next) => {
  req.rawBody = '';
  req.setEncoding('utf8');

  req.on('data', function (chunk) {
    req.rawBody += chunk;
  });

  req.on('end', function () {
    try {
      req.body = JSON.parse(req.rawBody);
    } catch (error) {
      req.body = {};
    }
    next();
  });
};

/**
 * Middleware para validar la estructura del webhook de TikTok
 */
exports.validateWebhookStructure = (req, res, next) => {
  const body = req.body;

  // Validar estructura básica
  if (!body || typeof body !== 'object') {
    console.log(
      '[TIKTOK_WEBHOOK] Estructura de webhook inválida: body no es objeto'
    );
    return res.status(400).json({ error: 'Invalid webhook structure' });
  }

  // Para verificación de webhook
  if (req.method === 'GET') {
    const {
      'hub.mode': mode,
      'hub.verify_token': token,
      'hub.challenge': challenge,
    } = req.query;

    if (mode && token && challenge) {
      // Es una verificación de webhook válida
      return next();
    }
  }

  // Para eventos de webhook
  if (req.method === 'POST') {
    if (!body.data || !Array.isArray(body.data)) {
      console.log(
        '[TIKTOK_WEBHOOK] Estructura de webhook inválida: data no es array'
      );
      return res.status(400).json({ error: 'Invalid webhook data structure' });
    }

    // Validar que cada evento tenga los campos mínimos
    for (const event of body.data) {
      if (!event.event_type) {
        console.log('[TIKTOK_WEBHOOK] Evento sin event_type');
        return res.status(400).json({ error: 'Event missing event_type' });
      }
    }
  }

  next();
};

/**
 * Middleware para rate limiting específico de webhooks
 */
exports.webhookRateLimit = (req, res, next) => {
  const ip = req.ip || req.connection.remoteAddress;
  const now = Date.now();
  const windowMs = 60 * 1000; // 1 minuto
  const maxRequests = 100; // máximo 100 requests por minuto

  if (!global.webhookRateLimitStore) {
    global.webhookRateLimitStore = new Map();
  }

  const store = global.webhookRateLimitStore;
  const key = `webhook_${ip}`;
  const windowStart = now - windowMs;

  // Limpiar entradas antiguas
  for (const [storeKey, timestamps] of store.entries()) {
    store.set(
      storeKey,
      timestamps.filter((timestamp) => timestamp > windowStart)
    );
    if (store.get(storeKey).length === 0) {
      store.delete(storeKey);
    }
  }

  // Verificar límite para esta IP
  const requests = store.get(key) || [];
  const recentRequests = requests.filter(
    (timestamp) => timestamp > windowStart
  );

  if (recentRequests.length >= maxRequests) {
    console.log(`[TIKTOK_WEBHOOK] Rate limit excedido para IP: ${ip}`);
    return res.status(429).json({ error: 'Rate limit exceeded' });
  }

  // Agregar esta request
  recentRequests.push(now);
  store.set(key, recentRequests);

  next();
};

/**
 * Middleware para logging específico de webhooks
 */
exports.logWebhookRequest = (req, res, next) => {
  const ip = req.ip || req.connection.remoteAddress;
  const userAgent = req.headers['user-agent'] || 'Unknown';
  const method = req.method;
  const timestamp = new Date().toISOString();

  console.log(
    `[TIKTOK_WEBHOOK] ${timestamp} - ${method} ${req.originalUrl} - IP: ${ip} - UA: ${userAgent}`
  );

  if (method === 'POST' && req.body) {
    const eventTypes = req.body.data
      ? req.body.data.map((e) => e.event_type).join(', ')
      : 'Unknown';
    console.log(`[TIKTOK_WEBHOOK] Eventos recibidos: ${eventTypes}`);
  }

  next();
};

/**
 * Middleware para manejar errores específicos de webhooks
 */
exports.handleWebhookError = (error, req, res, next) => {
  console.error('[TIKTOK_WEBHOOK] Error procesando webhook:', error);

  // Log del error para debugging
  console.error('Webhook Error Details:', {
    method: req.method,
    url: req.originalUrl,
    headers: req.headers,
    body: req.body,
    error: error.message,
    stack: error.stack,
  });

  // Siempre responder con 200 para webhooks para evitar reenvíos
  // TikTok puede reenviar si recibe un código de error
  res.status(200).json({
    error: 'Webhook processed with errors',
    message: 'Event logged for manual review',
  });
};

/**
 * Middleware para verificar que el webhook viene de TikTok
 */
exports.validateTikTokOrigin = (req, res, next) => {
  const userAgent = req.headers['user-agent'] || '';
  const allowedUserAgents = [
    'TikTok-Webhooks',
    'TikTokBot',
    'TikTok Business API',
  ];

  // En desarrollo, permitir todos los user agents
  if (process.env.NODE_ENV === 'development') {
    return next();
  }

  // Verificar que el user agent sea de TikTok
  const isValidOrigin = allowedUserAgents.some((agent) =>
    userAgent.includes(agent)
  );

  if (!isValidOrigin) {
    console.log(`[TIKTOK_WEBHOOK] User agent sospechoso: ${userAgent}`);
    // No bloquear completamente, pero loggear para investigación
  }

  next();
};
