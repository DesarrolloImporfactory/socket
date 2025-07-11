const jwt = require('jsonwebtoken');

/**
 * 1) Valida el JWT firmado en el ERP
 * 2) Inicia sesión del agente (opcional: crea cookie)
 * 3) Redirige a /chat con phone y name
 */
exports.sso = async (req, res) => {
  try {
    const { token, phone, name = '' } = req.query;
    if (!token || !phone) {
      return res
        .status(400)
        .json({ message: 'token y phone son obligatorios' });
    }

    const payload = jwt.verify(token, process.env.CHAT_CENTER_SSO_KEY); // HS256

    /* --------- inicia sesión local --------- */
    // Ejemplo mínimo: guardo idAgente en la sesión de Express
    req.session.userId = payload.sub; // id del agente
    req.session.idCallCenter = payload.cc ?? 0; // por si lo necesitas

    /* --------- redirección a la UI React ----- */
    const qs = new URLSearchParams({ phone, name }).toString();
    return res.redirect(`/chat?${qs}`);
  } catch (err) {
    console.error(err);
    return res.status(401).send('SSO inválido');
  }
};
