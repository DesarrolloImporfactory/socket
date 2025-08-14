const jwt = require('jsonwebtoken');

// CREA un state con el id del sub-usuario logueado
function makeState(uid, redirectAfter = '/') {
  return jwt.sign(
    { uid, redirectAfter },
    process.env.GOOGLE_OAUTH_STATE_SECRET,
    { expiresIn: '10m' } // corto: anti-replay
  );
}

// LEE/valida el state al volver de Google
function readState(state) {
  return jwt.verify(state, process.env.GOOGLE_OAUTH_STATE_SECRET);
}

module.exports = { makeState, readState };
