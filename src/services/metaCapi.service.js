/**
 * services/metaCapi.service.js
 * Envío de eventos a Meta Conversions API (CAPI)
 */

const axios = require('axios');
const crypto = require('crypto');
const logger = require('../utils/logger');

const GRAPH_BASE = `https://graph.facebook.com/${process.env.GRAPH_VERSION}`;

/**
 * SHA256 en hex lowercase (formato que Meta exige)
 */
function sha256(str) {
  if (!str) return null;
  const normalized = String(str).trim().toLowerCase();
  if (!normalized) return null;
  return crypto.createHash('sha256').update(normalized).digest('hex');
}

/**
 * Normaliza teléfono a E.164 sin '+', con código país Ecuador por default
 * Ej: 0987654321 → 593987654321
 *     +593 98 765 4321 → 593987654321
 */
function normalizePhoneE164(phone, defaultCountryCode = '593') {
  if (!phone) return null;
  let d = String(phone).replace(/\D/g, '');
  if (!d) return null;
  if (d.startsWith('0')) d = d.slice(1);
  if (!d.startsWith(defaultCountryCode)) d = defaultCountryCode + d;
  return d;
}

/**
 * Arma user_data hasheado según especificación Meta
 */
function buildUserData({
  phone,
  firstName,
  lastName,
  ctwaClid,
  email,
  wabaId,
  pageId,
}) {
  const userData = {};

  if (phone) {
    const phoneNorm = normalizePhoneE164(phone);
    if (phoneNorm) userData.ph = [sha256(phoneNorm)];
  }
  if (firstName) userData.fn = [sha256(String(firstName).toLowerCase().trim())];
  if (lastName) userData.ln = [sha256(String(lastName).toLowerCase().trim())];
  if (email) userData.em = [sha256(String(email).toLowerCase().trim())];
  if (ctwaClid) userData.ctwa_clid = ctwaClid;

  // REQUERIDO por Meta para action_source: business_messaging + channel: whatsapp
  if (wabaId) userData.whatsapp_business_account_id = String(wabaId);
  if (pageId) userData.page_id = String(pageId);

  return userData;
}

/**
 * Envía Purchase a CAPI.
 * Retorna { success, statusCode, response, errorCode, errorMessage }
 */
async function sendPurchaseEvent({
  pixelId,
  accessToken,
  eventId,
  value,
  currency = 'USD',
  eventTime,
  orderId,
  adId = null,
  user = {},
  testEventCode = null,
}) {
  if (!pixelId || !accessToken || !eventId) {
    throw new Error('pixelId, accessToken y eventId son requeridos');
  }

  const eventTimeUnix = Math.floor(
    (eventTime instanceof Date ? eventTime : new Date(eventTime)).getTime() /
      1000,
  );

  const event = {
    event_name: 'Purchase',
    event_time: eventTimeUnix,
    event_id: eventId,
    action_source: 'business_messaging',
    messaging_channel: 'whatsapp',
    user_data: buildUserData(user),
    custom_data: {
      currency,
      value: Number(value || 0),
      order_id: String(orderId),
      ...(adId ? { ad_id: String(adId) } : {}),
    },
  };

  const payload = { data: [event] };
  if (testEventCode) payload.test_event_code = testEventCode;

  const url = `${GRAPH_BASE}/${pixelId}/events?access_token=${accessToken}`;

  try {
    const resp = await axios.post(url, payload, {
      timeout: 15000,
      validateStatus: () => true,
    });

    return {
      success: resp.status >= 200 && resp.status < 300,
      statusCode: resp.status,
      response: resp.data,
      errorCode: resp.data?.error?.code || null,
      errorMessage: resp.data?.error?.message || null,
    };
  } catch (err) {
    return {
      success: false,
      statusCode: 0,
      response: null,
      errorCode: 'NETWORK_ERROR',
      errorMessage: err.message,
    };
  }
}

module.exports = {
  sendPurchaseEvent,
  buildUserData,
  normalizePhoneE164,
  sha256,
};
