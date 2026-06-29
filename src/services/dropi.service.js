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

    instance.interceptors.request.use(async (config) => {
      await limiter.acquire();
      config.__dropiSlot = true;
      return config;
    });

    instance.interceptors.response.use(
      (response) => {
        if (response?.config?.__dropiSlot) limiter.release();
        return response;
      },
      (error) => {
        if (error?.config?.__dropiSlot) limiter.release();
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

function normalizeDropiError(err) {
  const status = err?.response?.status || 500;
  const data = err?.response?.data;

  // Solo log básico, sin headers ni token
  console.log(
    `[Dropi Error] ${status} - ${err?.config?.method?.toUpperCase()} ${err?.config?.url} - ${JSON.stringify(data)}`,
  );

  const msg =
    (data && (data.message || data.msg || data.error)) ||
    err?.message ||
    'Error desconocido en Dropi';

  const appError = new AppError(`Dropi: ${msg}`, status);
  appError.statusCode = status;
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
