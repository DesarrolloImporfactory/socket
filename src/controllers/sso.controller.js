const jwt = require('jsonwebtoken');

/**
 * 1. Valida el JWT que llega desde el ERP (firma CHAT_CENTER_SSO_KEY)
 * 2. Genera el JWT estándar que tu SPA (React) reconoce
 * 3. Devuelve un pequeño <script> que:
 *      – Guarda el token en localStorage
 *      – (opcional) guarda phone y name para que React los use
 *      – Redirige a /chat
 */
exports.sso = (req, res) => {
  try {
    /* 1️⃣  Parámetros obligatorios */
    const { token: erpToken, phone, name = '' } = req.query;
    if (!erpToken || !phone) {
      return res
        .status(400)
        .json({ message: 'token y phone son obligatorios' });
    }

    /* 2️⃣  Verificar la firma generada por el ERP */
    const payloadERP = jwt.verify(
      erpToken,
      process.env.CHAT_CENTER_SSO_KEY // ← MISMA clave que usa PHP
    ); // Algoritmo HS256 por defecto

    /* 3️⃣  Generar el JWT “normal” que tu SPA entiende */
    const agentToken = jwt.sign(
      { id: payloadERP.sub, cc: payloadERP.cc ?? 0 },
      process.env.SECRET_JWT_SEED, // ← clave de tu sistema existente
      { expiresIn: process.env.JWT_EXPIRE_IN || '12h' }
    );

    /* 4️⃣  Responder con HTML+JS en lugar de redirect  */
    const extraPhone = phone
      ? `localStorage.setItem('sso_phone','${phone}');`
      : '';
    const extraName = name ? `localStorage.setItem('sso_name','${name}');` : '';

    return res.send(`
      <!doctype html><html><head><meta charset="utf-8"></head><body>
      <script>
        localStorage.setItem('token', '${agentToken}');
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
