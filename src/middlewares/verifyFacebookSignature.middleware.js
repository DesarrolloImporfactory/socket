const crypto = require('crypto');

module.exports = function verifyFacebookSignature(req, res, next) {
  if (req.signatureVerified && req.fbAppSecretOverride) {
    return next();
  }

  const appSecret = req.fbAppSecretOverride || process.env.FB_APP_SECRET;
  if (!appSecret) {
    console.error('[FB SIGN] Falta FB_APP_SECRET en el servidor');
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

  const expectedHash = crypto
    .createHmac('sha256', appSecret)
    .update(req.rawBody)
    .digest('hex');

  const a = Buffer.from(theirHash, 'hex');
  const b = Buffer.from(expectedHash, 'hex');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    console.error('[FB SIGN] mismatch', { expectedHash, theirHash });
    return res.status(401).send('Invalid signature');
  }

  next();
};
