const express = require('express');
const { google } = require('googleapis');
const { makeState, readState } = require('../utils/googleState');
const { db } = require('../database/config');
const { protect } = require('../middlewares/auth.middleware'); // tu middleware
const router = express.Router();

const SCOPES = [
  'openid',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
  'https://www.googleapis.com/auth/calendar',
];

/**
 * Elige el redirect según el entorno:
 * - Si NODE_ENV === 'production' -> usa GOOGLE_REDIRECT_URI (prod)
 * - Si NO es production          -> usa GOOGLE_REDIRECT_URI_DEV (si existe) o cae a GOOGLE_REDIRECT_URI
 */
function getRedirectUri() {
  const isProd = process.env.NODE_ENV === 'production'; // (1)
  if (isProd) return process.env.GOOGLE_REDIRECT_URI; // (2)
  return (
    process.env.GOOGLE_REDIRECT_URI_DEV || // (3)
    process.env.GOOGLE_REDIRECT_URI
  ); // (4)
}

/**
 * Crea un cliente OAuth2 usando la URI elegida por getRedirectUri()
 */
function oauth2(redirectUri = getRedirectUri()) {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    redirectUri
  );
}

/**
 * GET /api/v1/google/auth
 * Inicia el flujo OAuth. Requiere usuario autenticado (protect).
 * Usa `state` para llevar el id_sub_usuario de forma segura.
 */
router.get('/google/auth', protect, (req, res) => {
  const uid = Number(req.sessionUser?.id_sub_usuario);
  if (!uid) return res.status(401).send('Usuario no autenticado');

  const client = oauth2(getRedirectUri()); // (5)
  const url = client.generateAuthUrl({
    access_type: 'offline', // (6) refresh_token
    prompt: 'consent', // (7) garantiza refresh la 1ª vez
    scope: SCOPES,
    state: makeState(uid, '/panel'), // (8) lleva tu uid
  });

  return res.redirect(url);
});

/**
 * GET /api/v1/google/oauth2/callback
 * Recibe ?code y ?state, intercambia por tokens y los guarda por usuario.
 * No usa protect (no viene tu token); valida el `state`.
 */
router.get('/google/oauth2/callback', async (req, res) => {
  try {
    const { code, state } = req.query;
    const { uid } = readState(state);

    const client = oauth2(getRedirectUri());
    const { tokens } = await client.getToken(code);
    client.setCredentials(tokens);

    // 1) Intento principal: endpoint userinfo
    let googleEmail = null;
    try {
      const oauth2api = google.oauth2({ version: 'v2', auth: client });
      const me = await oauth2api.userinfo.get();
      googleEmail = me?.data?.email || null;
    } catch (_) {}

    // 2) Fallback: decodificar id_token si vino (por 'openid')
    if (!googleEmail && tokens.id_token) {
      try {
        const payload = JSON.parse(
          Buffer.from(tokens.id_token.split('.')[1], 'base64').toString('utf8')
        );
        googleEmail = payload?.email || null;
      } catch {}
    }

    // 3) Guarda en DB (aunque no haya email, pero suele venir)
    await db.query(
      `INSERT INTO users_google_accounts
        (id_sub_usuario, google_email, access_token, refresh_token, expiry_date, calendar_id)
       VALUES (?, ?, ?, ?, ?, 'primary')
       ON DUPLICATE KEY UPDATE
         google_email = VALUES(google_email),
         access_token = VALUES(access_token),
         refresh_token = IFNULL(VALUES(refresh_token), refresh_token),
         expiry_date  = VALUES(expiry_date)`,
      {
        replacements: [
          uid,
          googleEmail || '',
          tokens.access_token || null,
          tokens.refresh_token || null,
          tokens.expiry_date || null,
        ],
        type: db.QueryTypes.INSERT,
      }
    );

    return res.send(
      '✅ Google Calendar vinculado. Ya puede cerrar esta pestaña.'
    );
  } catch (e) {
    console.error(e);
    return res.status(500).send('Error al vincular Google Calendar');
  }
});

/**
 * GET /api/v1/google/status
 * Para que tu UI sepa si está vinculado y con qué correo.
 */
router.get('/google/status', protect, async (req, res) => {
  const uid = Number(req.sessionUser?.id_sub_usuario);
  const rows = await db.query(
    `SELECT google_email FROM users_google_accounts WHERE id_sub_usuario = ? LIMIT 1`,
    { replacements: [uid], type: db.QueryTypes.SELECT }
  );
  const linked = !!rows.length;
  return res.json({ linked, google_email: rows[0]?.google_email || null });
});

/**
 * POST /api/v1/google/unlink
 * Desvincula (elimina tokens). Opcional: también podrías desactivar watch.
 */
router.post('/google/unlink', protect, async (req, res) => {
  const uid = Number(req.sessionUser?.id_sub_usuario);
  await db.query(
    `UPDATE users_google_accounts
     SET is_active = 0, revoked_at = NOW(),
         access_token = NULL, refresh_token = NULL, expiry_date = NULL
     WHERE id_sub_usuario = ?`,
    { replacements: [uid], type: db.QueryTypes.UPDATE }
  );
  return res.json({ status: 'success' });
});

// GET /api/v1/google/auth-url  -> devuelve { url } (usa protect con Bearer)
router.get('/google/auth-url', protect, (req, res) => {
  const uid = Number(req.sessionUser?.id_sub_usuario);
  if (!uid) return res.status(401).json({ message: 'No autorizado' });

  const client = oauth2(getRedirectUri());
  const url = client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: SCOPES,
    state: makeState(uid, '/panel'),
  });

  return res.json({ url });
});

module.exports = router;
