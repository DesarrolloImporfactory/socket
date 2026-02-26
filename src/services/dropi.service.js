const axios = require('axios');
const AppError = require('../utils/appError');

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
    httpInstances[code] = axios.create({
      baseURL,
      timeout: 20000,
    });
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

  const msg =
    (data && (data.message || data.msg || data.error)) ||
    err?.message ||
    'Error desconocido en Dropi';

  return new AppError(`Dropi: ${msg}`, status);
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
