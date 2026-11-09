const jwt = require('jsonwebtoken');

/**
 * Crea un JWT corto para el parámetro `state` de OAuth.
 * Permite payloads como: { uid, calendarId, redirectAfter }
 */
function makeState(payload) {
  /* 60 min y no 10: entre pulsar «Conectar Google» y volver, la persona
     puede tener que iniciar sesión en Google, pasar la pantalla de «app no
     verificada» y los avisos de seguridad. Con 10 min un state caducado
     terminaba en el 500 genérico del callback (UNNICO, 2026-11-09). El
     anti-replay real es el code de Google, que solo se canjea una vez. */
  return jwt.sign(payload || {}, process.env.GOOGLE_OAUTH_STATE_SECRET, {
    expiresIn: '60m',
  });
}

/**
 * Valida y decodifica el `state` recibido en el callback de OAuth.
 */
function readState(state) {
  return jwt.verify(state, process.env.GOOGLE_OAUTH_STATE_SECRET);
}

module.exports = { makeState, readState };
