const axios = require('axios');
const AppError = require('../utils/appError');
// Limitador GLOBAL de salidas a Dropi (rate-limit por IP del servidor).
const { getLimiter } = require('../utils/dropiRateLimiter');

// Map de baseURL por country_code
const DROPI_BASE_URLS = {
  EC: process.env.DROPI_BASE_URL_EC,
  CO: process.env.DROPI_BASE_URL_CO,
  GT: process.env.DROPI_BASE_URL_GT,
  MX: process.env.DROPI_BASE_URL_MX,
};

// Crea o reutiliza un axios instance por país
const httpInstances = {};

function getDropiHttp(country_code) {
  const code = String(country_code || '').toUpperCase();
  const baseURL = DROPI_BASE_URLS[code];

  if (!baseURL) {
    throw new AppError(`Dropi: país no soportado (${code})`, 400);
  }

  if (!httpInstances[code]) {
    const instance = axios.create({
      baseURL,
      timeout: 20000,
    });

    // Toda petición de esta instancia pasa por el limitador global del país:
    // adquiere un slot antes de salir y lo libera al recibir respuesta o error.
    // Esto espacia/serializa el tráfico agregado hacia Dropi (cron + syncs +
    // socket + historial) para no reventar el rate-limit por IP.
    const limiter = getLimiter(code);

    // Diagnóstico: separar tiempo en cola (limitador) vs tiempo HTTP real.
    const SLOW_MS = Number(process.env.DROPI_LOG_SLOW_MS) || 1500;
    const logSlow = (config, httpMs, extra = '') => {
      const queueMs = config?.__queueMs ?? 0;
      if (queueMs >= SLOW_MS || httpMs >= SLOW_MS) {
        console.log(
          `[dropi ${code}] ${config?.method?.toUpperCase()} ${config?.url} cola=${queueMs}ms http=${httpMs}ms${extra}`,
        );
      }
    };

    instance.interceptors.request.use(async (config) => {
      const t0 = Date.now();
      await limiter.acquire(
        `${config?.method?.toUpperCase()} ${config?.url}`,
      );
      config.__dropiSlot = true;
      config.__queueMs = Date.now() - t0;
      config.__sentAt = Date.now();
      return config;
    });

    instance.interceptors.response.use(
      (response) => {
        if (response?.config?.__dropiSlot) limiter.release();
        logSlow(response?.config, Date.now() - (response?.config?.__sentAt || Date.now()));
        return response;
      },
      (error) => {
        if (error?.config?.__dropiSlot) limiter.release();
        logSlow(
          error?.config,
          Date.now() - (error?.config?.__sentAt || Date.now()),
          ` ERROR=${error?.response?.status || error?.code || error?.message}`,
        );
        return Promise.reject(error);
      },
    );

    httpInstances[code] = instance;
  }

  return httpInstances[code];
}

function dropiHeaders(integrationKey) {
  const keyHeader = process.env.DROPI_KEY_HEADER;

  if (!integrationKey || !String(integrationKey).trim()) {
    throw new AppError('Dropi: integration key no disponible', 400);
  }

  return {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    [keyHeader]: String(integrationKey).trim(),
  };
}

// Mensajes empáticos hacia el cliente para situaciones donde el error NO es
// culpa suya ni nuestra, sino de Dropi (saturado, rate-limit, o caído). Se
// mapea aquí, en el único punto por el que pasan todas las llamadas a Dropi,
// para que cualquier consumidor (socket o HTTP) muestre el texto amigable sin
// tener que repetir la detección en el front.
const DROPI_BUSY_MESSAGE =
  'Dropi está recibiendo muchas solicitudes en este momento. Por favor, vuelve a intentarlo en unos minutos o realiza la acción directamente en Dropi.';
const DROPI_DOWN_MESSAGE =
  'Dropi está presentando interferencias en este momento. Por favor, vuelve a intentarlo en unos minutos o realiza la acción directamente en Dropi.';

// ¿El error corresponde a rate-limit / demasiadas peticiones a Dropi?
function isDropiRateLimit(status, rawMsg) {
  if (status === 429) return true;
  const m = String(rawMsg || '').toLowerCase();
  return (
    m.includes('rate limit') ||
    m.includes('too many request') ||
    m.includes('demasiadas peticiones') ||
    m.includes('límite de peticiones') ||
    m.includes('limite de peticiones')
  );
}

// ¿Dropi no respondió / está caído? (timeout de axios, sin respuesta, o 5xx)
function isDropiUnavailable(err, status) {
  if (err?.code === 'ECONNABORTED') return true; // timeout de axios
  if (!err?.response) return true; // no hubo respuesta (network/DNS/down)
  return status === 502 || status === 503 || status === 504;
}

function normalizeDropiError(err) {
  const status = err?.response?.status || 500;
  const data = err?.response?.data;

  // Solo log básico, sin headers ni token
  console.log(
    `[Dropi Error] ${status} - ${err?.config?.method?.toUpperCase()} ${err?.config?.url} - ${JSON.stringify(data)}`,
  );

  const rawMsg =
    (data && (data.message || data.msg || data.error)) ||
    err?.message ||
    'Error desconocido en Dropi';

  // Por defecto, se mantiene el comportamiento anterior (mensaje crudo de Dropi).
  let userMessage = `Dropi: ${rawMsg}`;
  let code = null;

  if (isDropiRateLimit(status, rawMsg)) {
    userMessage = DROPI_BUSY_MESSAGE;
    code = 'DROPI_RATE_LIMIT';
  } else if (isDropiUnavailable(err, status)) {
    userMessage = DROPI_DOWN_MESSAGE;
    code = 'DROPI_UNAVAILABLE';
  }

  const appError = new AppError(userMessage, status);
  appError.statusCode = status;
  // Metadatos opcionales para que el front pueda detectar/estilizar el caso.
  appError.code = code;
  appError.dropiRawMessage = rawMsg;
  return appError;
}

/**
 * POST /orders/myorders
 */
exports.createOrderMyOrders = async ({
  integrationKey,
  payload,
  country_code,
}) => {
  try {
    const dropiHttp = getDropiHttp(country_code);
    const { data } = await dropiHttp.post('/orders/myorders', payload, {
      headers: dropiHeaders(integrationKey),
    });
    return data;
  } catch (err) {
    throw normalizeDropiError(err);
  }
};

/**
 * GET /orders/myorders  (Listar órdenes en Dropi)
 * params se envía como query string:
 *  { result_number, filter_date_by, from, until, status, textToSearch, ... }
 */
exports.listMyOrders = async ({ integrationKey, params, country_code }) => {
  try {
    const dropiHttp = getDropiHttp(country_code);
    const headers = dropiHeaders(integrationKey);

    const { data } = await dropiHttp.get('/orders/myorders', {
      headers,
      params,
    });

    return data;
  } catch (err) {
    throw normalizeDropiError(err);
  }
};

/**
 * GET /orders/myorders/v2/:orderId  (Detalle de una orden)
 */
exports.getOrderDetail = async ({ integrationKey, orderId, country_code }) => {
  try {
    const dropiHttp = getDropiHttp(country_code);
    const { data } = await dropiHttp.get(`/orders/myorders/${orderId}`, {
      headers: dropiHeaders(integrationKey),
      timeout: 15000,
    });
    return data;
  } catch (err) {
    throw normalizeDropiError(err);
  }
};

/**
 * POST /products/index
 */
exports.listProductsIndex = async ({
  integrationKey,
  payload,
  country_code,
}) => {
  try {
    const dropiHttp = getDropiHttp(country_code);
    const { data } = await dropiHttp.post('/products/index', payload, {
      headers: dropiHeaders(integrationKey),
    });
    return data;
  } catch (err) {
    throw normalizeDropiError(err);
  }
};

exports.listStates = async ({ integrationKey, country_id, country_code }) => {
  try {
    const dropiHttp = getDropiHttp(country_code);
    const { data } = await dropiHttp.get('/department', {
      headers: dropiHeaders(integrationKey),
      params: { country_id },
    });
    return data;
  } catch (err) {
    throw normalizeDropiError(err);
  }
};

exports.listCities = async ({ integrationKey, payload, country_code }) => {
  try {
    const dropiHttp = getDropiHttp(country_code);
    const { data } = await dropiHttp.post('/trajectory/bycity', payload, {
      headers: dropiHeaders(integrationKey),
    });
    return data;
  } catch (err) {
    throw normalizeDropiError(err);
  }
};

exports.cotizaEnvioTransportadora = async ({
  integrationKey,
  payload,
  country_code,
}) => {
  try {
    const dropiHttp = getDropiHttp(country_code);
    const { data } = await dropiHttp.post(
      '/orders/cotizaEnvioTransportadoraV2',
      payload,
      {
        headers: dropiHeaders(integrationKey),
      },
    );
    return data;
  } catch (err) {
    throw normalizeDropiError(err);
  }
};

exports.updateMyOrder = async ({
  integrationKey,
  orderId,
  payload,
  country_code,
}) => {
  try {
    const dropiHttp = getDropiHttp(country_code);
    const { data } = await dropiHttp.put(
      `/orders/myorders/${orderId}`,
      payload,
      {
        headers: dropiHeaders(integrationKey),
      },
    );
    return data;
  } catch (err) {
    throw normalizeDropiError(err);
  }
};

exports.getProductDetail = async ({
  integrationKey,
  productId,
  country_code,
}) => {
  try {
    const dropiHttp = getDropiHttp(country_code);
    const { data } = await dropiHttp.get(`/products/v2/${productId}`, {
      headers: dropiHeaders(integrationKey),
    });
    return data;
  } catch (err) {
    throw normalizeDropiError(err);
  }
};

exports.getOriginCityForShipping = async ({
  integrationKey,
  productId,
  productType,
  destination,
  country_code,
}) => {
  try {
    const dropiHttp = getDropiHttp(country_code);
    const { data } = await dropiHttp.post(
      '/orders/getOriginCityForCalculateShipping',
      {
        id: Number(productId),
        type: productType || 'SIMPLE',
        destination: destination || '',
      },
      {
        headers: dropiHeaders(integrationKey),
        timeout: 15000,
      },
    );
    return data;
  } catch (err) {
    throw normalizeDropiError(err);
  }
};

/**
 * POST /orders/myorders/client-stats
 * Historial cross-store del cliente en Dropi
 */
exports.getClientStats = async ({ integrationKey, orderIds, country_code }) => {
  try {
    const dropiHttp = getDropiHttp(country_code);
    const { data } = await dropiHttp.get(
      '/orders/myorders/client-stats',
      { order_ids: orderIds },
      { headers: dropiHeaders(integrationKey) },
    );
    return data;
  } catch (err) {
    throw normalizeDropiError(err);
  }
};
