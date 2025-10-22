const crypto = require('crypto');

// Middleware para validar la firma del webhook de TikTok
exports.validateTikTokWebhookSignature = (req, res, next) => {
  const clientSecret = process.env.TIKTOK_CLIENT_SECRET;
  if (!clientSecret) {
    console.log('[TIKTOK_WEBHOOK] Falta TIKTOK_CLIENT_SECRET');
    return res.status(500).json({ error: 'Client secret not configured' });
  }

  // Header correcto en TikTok for Developers
  const sigHeader =
    req.headers['tiktok-signature'] ||
    req.headers['TikTok-Signature'.toLowerCase()];
  if (!sigHeader) {
    return res.status(401).json({ error: 'Missing TikTok-Signature header' });
  }

  // Esperado: "t=...,s=..."
  const parts = sigHeader.split(',').map((p) => p.trim());
  const tPart = parts.find((p) => p.startsWith('t='));
  const sPart = parts.find((p) => p.startsWith('s='));
  if (!tPart || !sPart) {
    return res.status(401).json({ error: 'Invalid TikTok-Signature format' });
  }

  const timestamp = tPart.split('=')[1];
  const signature = sPart.split('=')[1]; // <- hex

  if (!req.rawBody) {
    return res.status(400).json({ error: 'rawBody missing' });
  }

  try {
    const signedPayload = `${timestamp}.${
      Buffer.isBuffer(req.rawBody) ? req.rawBody.toString('utf8') : req.rawBody
    }`;
    const hmac = require('crypto').createHmac('sha256', clientSecret);
    hmac.update(signedPayload, 'utf8');
    const expectedHex = hmac.digest('hex');

    const ok = crypto.timingSafeEqual(
      Buffer.from(signature, 'utf8'),
      Buffer.from(expectedHex, 'utf8')
    );
    if (!ok) {
      return res.status(401).json({ error: 'Invalid signature' });
    }

    // (Opcional) rechaza replays si el timestamp es viejo, ej. >5 min
    const ageSec = Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp));
    if (ageSec > 300) {
      return res.status(408).json({ error: 'Signature too old' });
    }

    return next();
  } catch (e) {
    console.error('[TIKTOK_WEBHOOK] Signature validation failed:', e);
    return res.status(500).json({ error: 'Signature validation failed' });
  }
};

/**
 * Middleware para validar la estructura del webhook de TikTok
 */
exports.validateWebhookStructure = (req, res, next) => {
  const body = req.body;

  if (!body || typeof body !== 'object') {
    return res.status(400).json({ error: 'Invalid webhook body' });
  }

  // 1) Ping del Portal (Test URL) -> pasa directo
  if (body.event === 'tiktok.ping') {
    return next();
  }

  // 2) (Opcional) flujo de verificación tipo hub.* si alguna vez lo usas
  if (req.method === 'GET') {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];
    if (mode && token && challenge) {
      return next();
    }
  }

  // 3) Para eventos "reales": si viene data[], valida mínimamente; si no viene, deja pasar
  if (req.method === 'POST') {
    if (body.data !== undefined) {
      if (!Array.isArray(body.data)) {
        return res.status(400).json({
          error: 'Invalid webhook data structure (data must be array)',
        });
      }
      for (const event of body.data) {
        if (!event.event_type) {
          return res.status(400).json({ error: 'Event missing event_type' });
        }
      }
    }
  }

  return next();
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

/**
 * Middleware avanzado para logging detallado de webhooks
 */
exports.advancedWebhookLogger = async (req, res, next) => {
  const startTime = Date.now();
  const ip = req.ip || req.connection.remoteAddress;
  const userAgent = req.headers['user-agent'] || 'Unknown';
  const method = req.method;
  const timestamp = new Date().toISOString();

  // Detectar si viene de TikTok
  const isTikTokRequest = exports.detectTikTokRequest(req);
  const isTestRequest = exports.detectTestRequest(req);

  console.log(
    `[TIKTOK_WEBHOOK] ${timestamp} - ${method} ${req.originalUrl} - IP: ${ip} - UA: ${userAgent}`
  );

  if (isTikTokRequest) {
    console.log(`[TIKTOK_WEBHOOK] ✅ Petición detectada como de TikTok`);
  }

  if (isTestRequest) {
    console.log(`[TIKTOK_WEBHOOK] 🧪 Petición de prueba detectada`);
  }

  if (method === 'POST' && req.body) {
    const eventTypes = req.body.data
      ? req.body.data.map((e) => e.event_type).join(', ')
      : 'Unknown';
    console.log(`[TIKTOK_WEBHOOK] Eventos recibidos: ${eventTypes}`);
  }

  // Capturar respuesta para logging
  const originalSend = res.send;
  const originalJson = res.json;
  let responseBody = '';

  res.send = function (body) {
    responseBody = body;
    return originalSend.call(this, body);
  };

  res.json = function (body) {
    responseBody = JSON.stringify(body);
    return originalJson.call(this, body);
  };

  // Continuar con el siguiente middleware
  res.on('finish', async () => {
    const processingTime = Date.now() - startTime;

    try {
      // Guardar log en base de datos
      await exports.saveWebhookLog({
        request_method: method,
        request_url: req.originalUrl,
        request_headers: JSON.stringify(exports.sanitizeHeaders(req.headers)),
        request_body: method === 'POST' ? JSON.stringify(req.body) : null,
        request_query:
          Object.keys(req.query).length > 0 ? JSON.stringify(req.query) : null,
        source_ip: ip,
        user_agent: userAgent,
        response_status: res.statusCode,
        response_body: responseBody,
        processing_time_ms: processingTime,
        is_tiktok_request: isTikTokRequest,
        is_test_request: isTestRequest,
        received_at: new Date(),
      });

      console.log(
        `[TIKTOK_WEBHOOK] ✅ Log guardado - Status: ${res.statusCode} - Tiempo: ${processingTime}ms`
      );
    } catch (error) {
      console.error('[TIKTOK_WEBHOOK] ❌ Error guardando log:', error);
    }
  });

  next();
};

/**
 * Detectar si la petición viene de TikTok
 */
exports.detectTikTokRequest = (req) => {
  const userAgent = req.headers['user-agent'] || '';
  const tikTokIndicators = ['TikTok', 'ByteDance', 'tiktok', 'bytedance'];

  return tikTokIndicators.some((indicator) =>
    userAgent.toLowerCase().includes(indicator.toLowerCase())
  );
};

/**
 * Detectar si es una petición de prueba
 */
exports.detectTestRequest = (req) => {
  // Detectar por headers o contenido del body
  const hasTestHeader =
    req.headers['x-tiktok-test'] || req.headers['x-test-event'];
  const hasTestInBody =
    req.body &&
    (req.body.test === true ||
      (req.body.data &&
        req.body.data.some((event) => event.event_type === 'TEST_EVENT')));

  return !!(hasTestHeader || hasTestInBody);
};

/**
 * Sanitizar headers para logging (remover información sensible)
 */
exports.sanitizeHeaders = (headers) => {
  const sanitizedHeaders = { ...headers };

  // Remover headers sensibles
  const sensitiveHeaders = [
    'authorization',
    'cookie',
    'x-api-key',
    'x-access-token',
  ];

  sensitiveHeaders.forEach((header) => {
    if (sanitizedHeaders[header]) {
      sanitizedHeaders[header] = '[REDACTED]';
    }
  });

  return sanitizedHeaders;
};

/**
 * Guardar log en base de datos
 */
exports.saveWebhookLog = async (logData) => {
  try {
    const { getModels } = require('../models/initModels');
    const { TikTokWebhookLog } = getModels();

    await TikTokWebhookLog.create(logData);
  } catch (error) {
    console.error('[TIKTOK_WEBHOOK] Error guardando en BD:', error);
    throw error;
  }
};
