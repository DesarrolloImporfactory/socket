// services/dropi.service.js
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
    const { data } = await dropiHttp.post('/orders/myorders', payload, {
      headers: dropiHeaders(integrationKey),
    });
    return data;
  } catch (err) {
    throw normalizeDropiError(err);
  }
};

/**
 * Helper genérico por si luego mete más endpoints.
 */
exports.post = async ({ integrationKey, path, payload }) => {
  try {
    const { data } = await dropiHttp.post(path, payload, {
      headers: dropiHeaders(integrationKey),
    });
    return data;
  } catch (err) {
    throw normalizeDropiError(err);
  }
};
