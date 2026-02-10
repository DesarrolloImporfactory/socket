const crypto = require('crypto');
const catchAsync = require('../utils/catchAsync');
const AppError = require('../utils/appError');
const DropiWebhookEvents = require('../models/dropi_webhook_events.model');

function digitsOnly(v) {
  return String(v || '').replace(/\D/g, '');
}

function sha256(str) {
  return crypto.createHash('sha256').update(str).digest('hex');
}

exports.dropiOrdersWebhook = catchAsync(async (req, res, next) => {
  // 1) Validación de secreto
  const expected = process.env.DROPI_WEBHOOK_SECRET;
  const got = req.headers['x-dropi-webhook-secret'];

  if (expected && String(expected).trim()) {
    if (!got || String(got).trim() !== String(expected).trim()) {
      return next(new AppError('Unauthorized webhook', 401));
    }
  }

  const body = req.body || {};

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
    // Duplicado por hash
    if (err?.name === 'SequelizeUniqueConstraintError') {
      return res.status(200).json({ ok: true, duplicated: true });
    }
    return next(err);
  }

  return res.status(200).json({ ok: true });
});
