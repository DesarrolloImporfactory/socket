const jwt = require('jsonwebtoken');
const crypto = require('crypto'); // ← nuevo: para generar el nonce

/**
 * 1. Valida el JWT firmado por el ERP (clave CHAT_CENTER_SSO_KEY)
 * 2. Genera el JWT habitual que usa tu SPA React
 * 3. Devuelve un mini-HTML con <script nonce="…"> que:
 *      – Guarda el token en localStorage
 *      – (opcional) guarda phone y name
 *      – Redirige a /chat
 *
 *  El nonce evita romper la política CSP global (script-src 'self')
 */
exports.sso = (req, res) => {
  try {
    /* 1️⃣  Parámetros requeridos */
    const { token: erpToken, phone, name = '' } = req.query;
    if (!erpToken || !phone) {
      return res
        .status(400)
        .json({ message: 'token y phone son obligatorios' });
    }

    /* 2️⃣  Verificar la firma HS256 puesta por el ERP */
    const payloadERP = jwt.verify(erpToken, process.env.CHAT_CENTER_SSO_KEY);

    /* 3️⃣  Crear el JWT “normal” de tu aplicación */
    const agentToken = jwt.sign(
      { id: payloadERP.sub, cc: payloadERP.cc ?? 0 },
      process.env.SECRET_JWT_SEED,
      { expiresIn: process.env.JWT_EXPIRE_IN || '12h' }
    );

    /* 4️⃣  CSP estricta con nonce + respuesta HTML */
    const nonce = crypto.randomBytes(16).toString('base64'); // nonce único

    res.set(
      'Content-Security-Policy',
      `default-src 'self'; script-src 'self' 'nonce-${nonce}';`
    );

    const extraPhone = phone
      ? `localStorage.setItem('sso_phone','${phone}');`
      : '';
    const extraName = name ? `localStorage.setItem('sso_name','${name}');` : '';

    return res.send(`
      <!doctype html>
      <html><head><meta charset="utf-8"></head><body>
        <script nonce="${nonce}">
          localStorage.setItem('token','${agentToken}');
          ${extraPhone}
          ${extraName}
          location.replace('/chat');
        </script>
      </body></html>
    `);
  } catch (err) {
    console.error('SSO error:', err);
    return res.status(401).send('SSO inválido');
  }
};
