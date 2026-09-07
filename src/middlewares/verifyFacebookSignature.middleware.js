const crypto = require('crypto');
const { listApps, resolveApp } = require('../config/metaApps');

/**
 * Valida X-Hub-Signature-256 contra el secreto de la app que firmó el evento.
 *
 * Con dos apps de Meta no se puede saber de antemano cuál firmó: el webhook
 * llega a la misma URL desde las dos y la cabecera no dice de quién viene. Por
 * eso se prueban todos los secretos configurados y gana el que cuadre. Son dos
 * HMAC sobre un cuerpo de unos pocos KB, así que el costo es irrelevante.
 *
 * Deja en `req.fbApp` la app que resultó ser la firmante, para que el resto
 * del pipeline sepa con qué secreto hablarle a Graph después.
 */
module.exports = function verifyFacebookSignature(req, res, next) {
  if (req.signatureVerified && req.fbAppSecretOverride) {
    return next();
  }

  // El override sigue funcionando igual que antes, pero ahora es la excepción
  // y no la vía principal.
  const candidatas = req.fbAppSecretOverride
    ? [{ key: 'override', secret: req.fbAppSecretOverride }]
    : listApps();

  if (!candidatas.length) {
    console.error(
      '[FB SIGN] No hay ninguna app de Meta configurada (falta FB_APP_ID/FB_APP_SECRET)',
    );
    return res.status(500).send('Server misconfigured');
  }

  const signature = req.get('x-hub-signature-256');
  if (!signature) return res.status(401).send('Missing X-Hub-Signature-256');

  const [algo, theirHash] = signature.split('=');
  if (algo !== 'sha256' || !theirHash) {
    return res.status(401).send('Invalid signature algorithm');
  }

  if (!req.rawBody || !Buffer.isBuffer(req.rawBody)) {
    console.error('[FB SIGN] rawBody missing/not Buffer');
    return res.status(401).send('Invalid signature (no raw body)');
  }

  let recibido;
  try {
    recibido = Buffer.from(theirHash, 'hex');
  } catch {
    return res.status(401).send('Invalid signature');
  }

  for (const app of candidatas) {
    const esperado = crypto
      .createHmac('sha256', app.secret)
      .update(req.rawBody)
      .digest();

    if (
      recibido.length === esperado.length &&
      crypto.timingSafeEqual(recibido, esperado)
    ) {
      req.fbApp = app.key === 'override' ? resolveApp(null) : app;
      req.signatureVerified = true;
      return next();
    }
  }

  // Solo se listan las claves internas, nunca los secretos.
  console.error('[FB SIGN] mismatch: ninguna app coincide', {
    probadas: candidatas.map((a) => a.key).join(','),
    theirHash,
  });
  return res.status(401).send('Invalid signature');
};
