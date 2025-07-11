const jwt = require('jsonwebtoken');

/**
 * 1. Valida el JWT que llega desde el ERP (firma CHAT_CENTER_SSO_KEY)
 * 2. Genera el JWT estándar que tu SPA (React) reconoce
 * 3. Redirige a /chat con phone, name y ese nuevo token
 *
 *  Nota:  NO usa ninguna base de datos; simplemente confía en el
 *  JWT del ERP y crea uno nuevo para el front-end.
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

    /* 2️⃣  Verificar la firma que puso el ERP */
    const payloadERP = jwt.verify(
      erpToken,
      process.env.CHAT_CENTER_SSO_KEY //  misma clave que el ERP
    ); //  HS256

    /* 3️⃣  Generar el JWT “normal” de la SPA */
    const agentToken = jwt.sign(
      {
        id: payloadERP.sub, // id del agente
        cc: payloadERP.cc ?? 0, // call-center (si aplica)
      },
      process.env.SECRET_JWT_SEED, //  << clave que ya usa tu login
      { expiresIn: process.env.JWT_EXPIRE_IN || '12h' }
    );

    /* 4️⃣  Redirigir a /chat llevando todo en la query */
    const qs = new URLSearchParams({
      phone,
      name,
      token: agentToken,
    }).toString();

    return res.redirect(`/chat?${qs}`);
  } catch (err) {
    console.error('SSO error:', err);
    return res.status(401).send('SSO inválido');
  }
};
