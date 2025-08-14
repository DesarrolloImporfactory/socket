const jwt = require('jsonwebtoken');

/**
 * Crea un JWT corto para el parámetro `state` de OAuth.
 * Permite payloads como: { uid, calendarId, redirectAfter }
 */
function makeState(payload) {
  return jwt.sign(payload || {}, process.env.GOOGLE_OAUTH_STATE_SECRET, {
    expiresIn: '10m', // corto: anti-replay
  });
}

/**
 * Valida y decodifica el `state` recibido en el callback de OAuth.
 */
function readState(state) {
  return jwt.verify(state, process.env.GOOGLE_OAUTH_STATE_SECRET);
}

module.exports = { makeState, readState };
