const axios = require('axios');
const AppError = require('../utils/appError');

const dropiHttp = axios.create({
  baseURL: process.env.DROPI_BASE_URL,
  timeout: Number(process.env.DROPI_TIMEOUT_MS || 20000),
});

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

  // Mensaje “más probable” que devuelven APIs
  const msg =
    (data && (data.message || data.msg || data.error)) ||
    err?.message ||
    'Error desconocido en Dropi';

  return new AppError(`Dropi: ${msg}`, status);
}

/**
 * POST /orders/myorders
 */
exports.createOrderMyOrders = async ({ integrationKey, payload }) => {
  try {
    const { data } = await dropiHttp.post('orders/myorders', payload, {
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
exports.listMyOrders = async ({ integrationKey, params }) => {
  try {
    const { data } = await dropiHttp.get('/orders/myorders', {
      headers: dropiHeaders(integrationKey),
      params,
    });
    return data;
  } catch (err) {
    throw normalizeDropiError(err);
  }
};

// POST /products/index
exports.listProductsIndex = async ({ integrationKey, payload }) => {
  try {
    const { data } = await dropiHttp.post('/products/index', payload, {
      headers: dropiHeaders(integrationKey),
    });
    return data;
  } catch (err) {
    throw normalizeDropiError(err);
  }
};

exports.listStates = async ({ integrationKey, country_id }) => {
  try {
    const { data } = await dropiHttp.get('/department', {
      headers: dropiHeaders(integrationKey),
      params: { country_id },
    });
    return data;
  } catch (err) {
    throw normalizeDropiError(err);
  }
};

exports.listCities = async ({ integrationKey, payload }) => {
  try {
    const { data } = await dropiHttp.post('/trajectory/bycity', payload, {
      headers: dropiHeaders(integrationKey),
    });
    return data;
  } catch (err) {
    throw normalizeDropiError(err);
  }
};

exports.cotizaEnvioTransportadora = async ({ integrationKey, payload }) => {
  try {
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

exports.updateMyOrder = async ({ integrationKey, orderId, payload }) => {
  try {
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
