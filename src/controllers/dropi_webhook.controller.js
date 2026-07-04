const crypto = require('crypto');
const catchAsync = require('../utils/catchAsync');
const AppError = require('../utils/appError');
const DropiWebhookEvents = require('../models/dropi_webhook_events.model');
const {
  encolarEventoWebhook,
} = require('../services/dropi_webhook_processor.service');

// Kill-switch del procesamiento en tiempo real (envío de templates al
// recibir el evento). Con '0' el webhook vuelve a ser solo-almacenamiento
// y el cron sigue cubriendo todo, sin deploy.
const REALTIME_ENABLED = process.env.DROPI_WEBHOOK_REALTIME !== '0';

function digitsOnly(v) {
  return String(v || '').replace(/\D/g, '');
}

function sha256(str) {
  return crypto.createHash('sha256').update(str).digest('hex');
}

// Dropi no permite configurar headers personalizados en sus webhooks, así que
// se valida por estructura: el body debe tener forma de evento de orden Dropi
// (id numérico, status, y al menos 3 campos típicos de sus payloads).
const DROPI_ORDER_FIELDS = [
  'type',
  'supplier_id',
  'shop_id',
  'shop',
  'rate_type',
  'shipping_company',
  'shipping_guide',
  'orderdetails',
  'warehouse_id',
  'country',
];

function esEventoDropi(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
  if (!Number.isFinite(Number(body.id)) || Number(body.id) <= 0) return false;
  if (!body.status || typeof body.status !== 'string') return false;
  const presentes = DROPI_ORDER_FIELDS.filter((f) => f in body).length;
  return presentes >= 3;
}

exports.dropiOrdersWebhook = catchAsync(async (req, res, next) => {
  const body = req.body || {};

  // 1) Validación por patrón del payload
  if (!esEventoDropi(body)) {
    return next(new AppError('Unauthorized webhook', 401));
  }

  console.log('📦 Dropi webhook recibido:', JSON.stringify(body, null, 2));

  const dropi_order_id = body.id ? Number(body.id) : null;
  const status = body.status ? String(body.status) : null;
  const supplier_id = body.supplier_id ? Number(body.supplier_id) : null;
  const shop_id = body.shop_id ? Number(body.shop_id) : null;

  const phone_raw = body.phone ?? null;
  const phone_digits = digitsOnly(phone_raw) || null;

  // 2) Hash idempotente: evita duplicados si Dropi reintenta
  const payloadStr = JSON.stringify(body);
  const event_hash = sha256(payloadStr);

  try {
    await DropiWebhookEvents.create({
      dropi_order_id,
      status,
      supplier_id,
      shop_id,
      phone_raw: phone_raw ? String(phone_raw) : null,
      phone_digits,
      external_id: body.external_id ? String(body.external_id) : null,
      shop_order_id: body.shop_order_id ? String(body.shop_order_id) : null,
      shop_order_number: body.shop_order_number
        ? String(body.shop_order_number)
        : null,
      shipping_company: body.shipping_company
        ? String(body.shipping_company)
        : null,
      shipping_guide: body.shipping_guide ? String(body.shipping_guide) : null,
      sticker: body.sticker ? String(body.sticker) : null,
      country: body.country ? String(body.country) : null,
      state: body.state ? String(body.state) : null,
      city: body.city ? String(body.city) : null,
      dir: body.dir ? String(body.dir) : null,

      payload: body, // JSON completo
      event_hash,
    });
  } catch (err) {
    // Duplicado por hash: Dropi reintentó el mismo evento → no reprocesar
    if (err?.name === 'SequelizeUniqueConstraintError') {
      return res.status(200).json({ ok: true, duplicated: true });
    }
    return next(err);
  }

  // Procesamiento en tiempo real (upsert cache + template WA), en cola
  // async: se responde 200 a Dropi de inmediato. Anti-duplicados con el
  // cron garantizado por reclamarEnvio (UNIQUE en dropi_plantillas_enviadas).
  if (REALTIME_ENABLED) {
    encolarEventoWebhook(body);
  }

  return res.status(200).json({ ok: true });
});
