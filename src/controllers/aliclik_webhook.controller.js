const crypto = require('crypto');
const catchAsync = require('../utils/catchAsync');
const AppError = require('../utils/appError');
const { db } = require('../database/config');
const AliclikWebhookEvents = require('../models/aliclik_webhook_events.model');
const {
  encolarEventoWebhook,
} = require('../services/aliclik_webhook_processor.service');

// Kill-switch del procesamiento en tiempo real: con '0' el webhook queda como
// solo-almacenamiento y el cron sigue cubriendo todo, sin necesidad de deploy.
const REALTIME_ENABLED = process.env.ALICLIK_WEBHOOK_REALTIME !== '0';

function sha256(str) {
  return crypto.createHash('sha256').update(str).digest('hex');
}

/**
 * El payload de Aliclik son 4 campos de texto, sin firma ni HMAC. Validarlo
 * por forma —como se hace con Dropi— acá no sirve de nada: cualquiera podría
 * armarlo y disparar plantillas de WhatsApp a los clientes de una cuenta.
 *
 * Lo que autentica el evento es el secreto en la URL. Aliclik deja que cada
 * cuenta pegue su propia URL de notificaciones, así que el secreto además
 * resuelve a qué configuración pertenece el evento (el payload tampoco trae
 * companyId ni integrationId).
 */
async function resolverIntegracionPorSecret(secret) {
  const clean = String(secret || '').trim();
  if (!clean || clean.length < 16) return null;

  const [row] = await db.query(
    `SELECT id, id_configuracion, token_enc, store_name
       FROM aliclik_integrations
      WHERE webhook_secret = ?
        AND is_active = 1
        AND deleted_at IS NULL
      LIMIT 1`,
    { replacements: [clean], type: db.QueryTypes.SELECT },
  );
  return row || null;
}

const ESTADOS_VALIDOS = /^[A-Z_]{2,40}$/;

function esEventoAliclik(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
  if (!body.orderNumber || typeof body.orderNumber !== 'string') return false;
  // Al menos uno de los tres ejes de estado, con forma de enum.
  const ejes = ['callStatus', 'status', 'dispatchStatus'];
  return ejes.some(
    (k) => typeof body[k] === 'string' && ESTADOS_VALIDOS.test(body[k].trim()),
  );
}

exports.aliclikOrdersWebhook = catchAsync(async (req, res, next) => {
  const body = req.body || {};

  // Las peticiones RECHAZADAS no dejaban ningún rastro: ni acá, ni en
  // aliclik_webhook_events (que solo guarda las aceptadas), ni en el access log
  // (morgan está mal configurado en producción). O sea que si el cliente pega
  // mal la URL, el síntoma es "no llega nada" y no había forma de distinguirlo
  // de que Aliclik no estuviera enviando. Por eso se registran los dos motivos.
  //
  // Del secreto solo se loguea el prefijo: sirve para reconocer cuál pegaron
  // sin dejar la credencial completa escrita en el log.
  const secretRecibido = String(req.params.secret || '');
  const pista = secretRecibido ? `${secretRecibido.slice(0, 8)}…` : '(vacío)';

  const integracion = await resolverIntegracionPorSecret(secretRecibido);
  if (!integracion) {
    console.log(
      `[AliclikWebhook] 401 secreto no reconocido (${pista}, ${secretRecibido.length} chars) — revisa la URL pegada en el panel de Aliclik`,
    );
    return next(new AppError('Unauthorized webhook', 401));
  }

  if (!esEventoAliclik(body)) {
    console.log(
      `[AliclikWebhook] 400 payload inválido (cfg ${integracion.id_configuracion}): ${JSON.stringify(body).slice(0, 300)}`,
    );
    return next(new AppError('Payload inválido', 400));
  }
  

  const orderNumber = String(body.orderNumber).trim();

  // Idempotencia: la doc de Aliclik avisa que los estados pueden llegar en
  // desorden y repetidos. El hash incluye la configuración porque el payload
  // es tan chico que dos cuentas podrían generar eventos idénticos.
  const event_hash = sha256(
    `${integracion.id_configuracion}|${JSON.stringify(body)}`,
  );

  try {
    await AliclikWebhookEvents.create({
      order_number: orderNumber,
      id_configuracion: integracion.id_configuracion,
      call_status: body.callStatus ? String(body.callStatus) : null,
      status: body.status ? String(body.status) : null,
      dispatch_status: body.dispatchStatus ? String(body.dispatchStatus) : null,
      payload: body,
      event_hash,
    });
  } catch (err) {
    // Duplicado por hash: Aliclik reenvió el mismo evento → no reprocesar.
    if (err?.name === 'SequelizeUniqueConstraintError') {
      console.log(
        `[AliclikWebhook] duplicado ${orderNumber} (cfg ${integracion.id_configuracion}) — ya procesado, se ignora`,
      );
      return res.status(200).json({ ok: true, duplicated: true });
    }
    return next(err);
  }

  // Una línea por evento aceptado. El procesador solo loguea cuando envía algo
  // o cuando falla, así que sin esto un evento que entra bien y no dispara
  // ninguna plantilla pasaba completamente en silencio.
  console.log(
    `[AliclikWebhook] 200 ${orderNumber} (cfg ${integracion.id_configuracion}) call=${body.callStatus || '-'} status=${body.status || '-'} dispatch=${body.dispatchStatus || '-'}`,
  );

  if (REALTIME_ENABLED) {
    encolarEventoWebhook({ payload: body, integracion });
  }

  return res.status(200).json({ ok: true });
});
