const crypto = require('crypto');

module.exports = function verifyFacebookSignature(req, res, next) {
  const signature = req.get('x-hub-signature-256');

  if (!signature) {
    return res.status(401).send('Missing X-Hub-Signature-256');
  }

  const [algo, theirHash] = signature.split('=');
  if (algo !== 'sha256') {
    return res.status(401).send('Invalid signature algorithm');
  }

  const appSecret = process.env.FB_APP_SECRET;
  const hmac = crypto.createHmac('sha256', appSecret);
  hmac.update(req.rawBody, 'utf-8');

  const expectedHash = hmac.digest('hex');

  if (
    !crypto.timingSafeEqual(Buffer.from(theirHash), Buffer.from(expectedHash))
  ) {
    return res.status(401).send('Invalid signature');
  }

  next();
};
