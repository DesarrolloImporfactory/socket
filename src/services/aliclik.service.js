'use strict';

/**
 * services/aliclik.service.js
 *
 * Cliente HTTP de la API de integraciones de Aliclik (operador de fulfillment
 * peruano). Documentación: https://aliclik.app/documentation
 *
 * Diferencias con dropi.service.js que explican por qué es un cliente aparte:
 *   · Una sola instancia: Aliclik es solo Perú, no hay baseURL por país.
 *   · Auth por Bearer + cabecera fija `x-aliclik-origin`, no por header de key.
 *   · Los errores 400 ya vienen en español y accionables según su doc, así que
 *     se muestran tal cual en lugar de traducirlos como se hizo con Dropi.
 */

const axios = require('axios');
const AppError = require('../utils/appError');
// Se reutiliza el limitador genérico de utils/dropiRateLimiter con una llave
// propia ('ALICLIK'): cada llave es una instancia independiente, así que el
// tráfico a Aliclik no compite con el de Dropi. Aliclik no publica sus cuotas
// (su doc solo menciona "ampliación de cuotas" en soporte), así que se sale
// espaciado por defecto igual que con Dropi.
const { getLimiter } = require('../utils/dropiRateLimiter');

const BASE_URL = process.env.ALICLIK_BASE_URL;
const ORIGIN_HEADER = process.env.ALICLIK_ORIGIN || 'aliclik-web';
const TIMEOUT_MS = Number(process.env.ALICLIK_TIMEOUT_MS) || 20000;

let httpInstance = null;

function getAliclikHttp() {
  if (!BASE_URL) {
    throw new AppError('Aliclik: falta ALICLIK_BASE_URL en el entorno', 500);
  }
  if (httpInstance) return httpInstance;

  const instance = axios.create({ baseURL: BASE_URL, timeout: TIMEOUT_MS });
  const limiter = getLimiter('ALICLIK');

  instance.interceptors.request.use(async (config) => {
    await limiter.acquire(
      `${config?.method?.toUpperCase()} ${config?.url}`,
    );
    config.__aliclikSlot = true;
    return config;
  });

  instance.interceptors.response.use(
    (response) => {
      if (response?.config?.__aliclikSlot) limiter.release();
      return response;
    },
    (error) => {
      if (error?.config?.__aliclikSlot) limiter.release();
      return Promise.reject(error);
    },
  );

  httpInstance = instance;
  return instance;
}

function aliclikHeaders(token) {
  if (!token || !String(token).trim()) {
    throw new AppError('Aliclik: token de integración no disponible', 400);
  }
  return {
    Authorization: `Bearer ${String(token).trim()}`,
    'Content-Type': 'application/json',
    'x-aliclik-origin': ORIGIN_HEADER,
  };
}

const ALICLIK_DOWN_MESSAGE =
  'Aliclik está presentando interferencias en este momento. Por favor, vuelve a intentarlo en unos minutos o realiza la acción directamente en Aliclik.';
const ALICLIK_TOKEN_MESSAGE =
  'El token de Aliclik es inválido o expiró. Vuelve a copiarlo desde el panel de Aliclik para reactivar la sincronización.';

function isAliclikUnavailable(err, status) {
  if (err?.code === 'ECONNABORTED') return true; // timeout
  if (!err?.response) return true; // sin respuesta (red/DNS/caído)
  return status === 502 || status === 503 || status === 504;
}

function normalizeAliclikError(err) {
  const status = err?.response?.status || 500;
  const data = err?.response?.data;

  console.log(
    `[Aliclik Error] ${status} - ${err?.config?.method?.toUpperCase()} ${err?.config?.url} - ${JSON.stringify(data)}`,
  );

  const rawMsg =
    (data && (data.message || data.error)) ||
    err?.message ||
    'Error desconocido en Aliclik';

  // Los 400 de Aliclik vienen en español y son accionables (lo dice su doc):
  // se propagan tal cual para mostrarlos al asesor sin traducir.
  let userMessage = Array.isArray(rawMsg) ? rawMsg.join('. ') : String(rawMsg);
  let code = null;

  if (status === 401) {
    userMessage = ALICLIK_TOKEN_MESSAGE;
    code = 'ALICLIK_TOKEN_INVALID';
  } else if (isAliclikUnavailable(err, status)) {
    userMessage = ALICLIK_DOWN_MESSAGE;
    code = 'ALICLIK_UNAVAILABLE';
  }

  const appError = new AppError(userMessage, status);
  appError.statusCode = status;
  appError.code = code;
  appError.aliclikRawMessage = rawMsg;
  return appError;
}

/* ═══════════════════════════════════════════════════════════
   Endpoints
   ═══════════════════════════════════════════════════════════ */

/**
 * GET /integration/order — listar pedidos de la integración.
 * params: { page, limit, orderNumber, callStatus, status, dispatchStatus,
 *           startDate, endDate }
 */
exports.listOrders = async ({ token, params }) => {
  try {
    const http = getAliclikHttp();
    const { data } = await http.get('/integration/order', {
      headers: aliclikHeaders(token),
      params,
    });
    return data;
  } catch (err) {
    throw normalizeAliclikError(err);
  }
};

/**
 * Trae UNA orden por su número exacto.
 *
 * El filtro `orderNumber` del listado es búsqueda parcial (contains), así que
 * puede devolver varias: el match exacto se filtra acá. Devuelve null si no
 * aparece.
 */
exports.getOrderByNumber = async ({ token, orderNumber }) => {
  const target = String(orderNumber || '').trim();
  if (!target) return null;

  const data = await exports.listOrders({
    token,
    params: { orderNumber: target, page: 1, limit: 100 },
  });

  const rows = Array.isArray(data?.data) ? data.data : [];
  return (
    rows.find(
      (o) => String(o?.orderNumber || '').trim() === target,
    ) || null
  );
};

/**
 * GET /integration/product/public — catálogo con stock virtual por almacén.
 * `isAgency=true` restringe a almacenes habilitados para envío por agencia.
 */
exports.listProducts = async ({ token, params }) => {
  try {
    const http = getAliclikHttp();
    const { data } = await http.get('/integration/product/public', {
      headers: aliclikHeaders(token),
      params,
    });
    return data;
  } catch (err) {
    throw normalizeAliclikError(err);
  }
};

/**
 * GET /integration/order/shipping/cost — couriers y costos para un destino.
 * El objeto `couriers[i]` se reusa tal cual como bloque `courier` al crear.
 */
exports.getShippingCost = async ({ token, warehouseId, lat, lng }) => {
  try {
    const http = getAliclikHttp();
    const { data } = await http.get('/integration/order/shipping/cost', {
      headers: aliclikHeaders(token),
      params: { warehouseId, lat: String(lat), lng: String(lng) },
    });
    return data;
  } catch (err) {
    throw normalizeAliclikError(err);
  }
};

/** POST /integration/order — crear pedido contraentrega. */
exports.createOrder = async ({ token, payload }) => {
  try {
    const http = getAliclikHttp();
    const { data } = await http.post('/integration/order', payload, {
      headers: aliclikHeaders(token),
    });
    return data;
  } catch (err) {
    throw normalizeAliclikError(err);
  }
};

/**
 * POST /integration/order/cancel — cancelar pedido contraentrega.
 *
 * OJO: Aliclik responde 201 en dos situaciones distintas. Si el pedido todavía
 * no está confirmado NO lo cancela: solo le agrega una nota y contesta
 * `{ message: "Pedido no confirmado." }`. Por eso se devuelve `cancelado`
 * explícito en vez de dejar que el llamador asuma éxito por el status code.
 */
exports.cancelOrder = async ({ token, orderNumber }) => {
  try {
    const http = getAliclikHttp();
    const { data } = await http.post(
      '/integration/order/cancel',
      { orderNumber },
      { headers: aliclikHeaders(token) },
    );
    const msg = String(data?.message || '');
    return {
      ...data,
      cancelado: !/no confirmado/i.test(msg),
    };
  } catch (err) {
    throw normalizeAliclikError(err);
  }
};

/** GET /integration/order/agencies — directorio de agencias de destino. */
exports.listAgencies = async ({ token }) => {
  try {
    const http = getAliclikHttp();
    const { data } = await http.get('/integration/order/agencies', {
      headers: aliclikHeaders(token),
    });
    return data;
  } catch (err) {
    throw normalizeAliclikError(err);
  }
};

/** GET /integration/order/package-sizes — tamaños de paquete disponibles. */
exports.listPackageSizes = async ({ token }) => {
  try {
    const http = getAliclikHttp();
    const { data } = await http.get('/integration/order/package-sizes', {
      headers: aliclikHeaders(token),
    });
    return data;
  } catch (err) {
    throw normalizeAliclikError(err);
  }
};

/** POST /integration/order/agency — crear pedido con recojo en agencia. */
exports.createAgencyOrder = async ({ token, payload }) => {
  try {
    const http = getAliclikHttp();
    const { data } = await http.post('/integration/order/agency', payload, {
      headers: aliclikHeaders(token),
    });
    return data;
  } catch (err) {
    throw normalizeAliclikError(err);
  }
};

/** POST /integration/order/agency/cancel — anular pedido por agencia. */
exports.cancelAgencyOrder = async ({ token, orderNumber }) => {
  try {
    const http = getAliclikHttp();
    const { data } = await http.post(
      '/integration/order/agency/cancel',
      { orderNumber },
      { headers: aliclikHeaders(token) },
    );
    return data;
  } catch (err) {
    throw normalizeAliclikError(err);
  }
};

exports.normalizeAliclikError = normalizeAliclikError;
