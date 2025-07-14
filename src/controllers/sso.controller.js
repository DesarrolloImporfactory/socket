/****************************************************************************************
 *  – Valida el token del ERP
 *  – Crea el JWT “normal” de la SPA
 *  – Devuelve mini-HTML con nonce que:
 *        a) guarda el token en localStorage (origen chat.)
 *        b) coloca también una cookie de dominio .imporfactory.app
 *        c) redirige al frontend https://chatcenter.imporfactory.app/chat
 ****************************************************************************************/
const jwt = require('jsonwebtoken');
const crypto = require('crypto');

exports.sso = (req, res) => {
  try {
    /* 1️⃣  Parámetros del query */
    const { token: erpToken, phone, name = '' } = req.query;
    if (!erpToken || !phone) {
      return res
        .status(400)
        .json({ message: 'token y phone son obligatorios' });
    }

    /* 2️⃣  Verificar firma del ERP (HS256) */
    const payloadERP = jwt.verify(erpToken, process.env.CHAT_CENTER_SSO_KEY);

    /* 3️⃣  Generar token estándar para la SPA */
    const agentToken = jwt.sign(
      { id: payloadERP.sub, cc: payloadERP.cc ?? 0 },
      process.env.SECRET_JWT_SEED,
      { expiresIn: process.env.JWT_EXPIRE_IN || '12h' }
    );

    /* 4️⃣  Nonce + CSP */
    const nonce = crypto.randomBytes(16).toString('base64');
    res.set(
      'Content-Security-Policy',
      `default-src 'self'; script-src 'self' 'nonce-${nonce}';`
    );

    /* 5️⃣  URL del frontend */
    const FRONT_URL = 'https://chatcenter.imporfactory.app/chat';

    /* 6️⃣  HTML de respuesta */
    const extraPhone = phone
      ? `localStorage.setItem('sso_phone','${phone}');`
      : '';
    const extraName = name ? `localStorage.setItem('sso_name','${name}');` : '';

    return res.send(`
      <!doctype html>
      <html><head><meta charset="utf-8"></head><body>
        <script nonce="${nonce}">
          /* Guardar en localStorage del origen actual (chat.) */
          localStorage.setItem('token','${agentToken}');
          ${extraPhone}${extraName}

          /* Guardar cookie accesible a *.imporfactory.app */
          document.cookie =
            "chat_token=${agentToken}; path=/; domain=.imporfactory.app; secure; samesite=lax";

          /* Ir al frontend */
          location.replace('${FRONT_URL}');
        </script>
      </body></html>
    `);
  } catch (err) {
    console.error('SSO error:', err);
    return res.status(401).send('SSO inválido');
  }
};
