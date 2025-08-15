const express = require('express');
const { google } = require('googleapis');
const { makeState, readState } = require('../utils/googleState');
const { db } = require('../database/config');
const { protect } = require('../middlewares/auth.middleware');

const router = express.Router();

const SCOPES = [
  'openid',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
  'https://www.googleapis.com/auth/calendar',
];

/** Redirect según entorno */
function getRedirectUri() {
  const isProd = process.env.NODE_ENV === 'production';
  if (isProd) return process.env.GOOGLE_REDIRECT_URI;
  return process.env.GOOGLE_REDIRECT_URI_DEV || process.env.GOOGLE_REDIRECT_URI;
}

/** Cliente OAuth2 */
function oauth2(redirectUri = getRedirectUri()) {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    redirectUri
  );
}

/**
 * Obtiene el id_usuario (dueño) a partir del id_sub_usuario.
 */
async function getOwnerUserIdBySub(uid) {
  const row = await db.query(
    `SELECT id_usuario FROM sub_usuarios_chat_center WHERE id_sub_usuario = ? LIMIT 1`,
    { replacements: [uid], type: db.QueryTypes.SELECT }
  );
  return row?.[0]?.id_usuario ? Number(row[0].id_usuario) : null;
}

/**
 * Valida y resuelve el calendar_id de SU tabla `calendars` para el sub-usuario:
 * 1) Si viene requestedCalendarId, verifica que pertenezca al mismo id_usuario (created_by).
 * 2) Si no es válido o no viene, toma el calendario más reciente creado por ese id_usuario.
 * Devuelve null si no encuentra ninguno (en la práctica el front ya hizo /calendars/ensure).
 */
async function resolveCalendarId(uid, requestedCalendarId) {
  const ownerUserId = await getOwnerUserIdBySub(uid);
  if (!ownerUserId) return null;

  // 1) Validar el solicitado contra created_by = id_usuario
  if (requestedCalendarId) {
    const ok = await db.query(
      `SELECT id FROM calendars WHERE id = ? AND created_by = ? LIMIT 1`,
      {
        replacements: [requestedCalendarId, ownerUserId],
        type: db.QueryTypes.SELECT,
      }
    );
    if (ok?.[0]?.id) return Number(ok[0].id);
  }

  // 2) Tomar el más reciente del mismo owner
  const last = await db.query(
    `SELECT id FROM calendars WHERE created_by = ? ORDER BY id DESC LIMIT 1`,
    { replacements: [ownerUserId], type: db.QueryTypes.SELECT }
  );
  return last?.[0]?.id ? Number(last[0].id) : null;
}

/**
 * GET /api/v1/google/auth-url
 * Devuelve la URL de autorización de Google. Usa `state` con { uid, calendarId }.
 * Se espera query param opcional: ?calendar_id=10
 */
router.get('/google/auth-url', protect, (req, res) => {
  const uid = Number(req.sessionUser?.id_sub_usuario);
  if (!uid) return res.status(401).json({ message: 'No autorizado' });

  const calendarId = req.query.calendar_id
    ? Number(req.query.calendar_id)
    : null;

  const client = oauth2(getRedirectUri());
  const url = client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: SCOPES,
    state: makeState({ uid, calendarId, redirectAfter: '/panel' }),
  });

  return res.json({ url });
});

/**
 * (Opcional) GET /api/v1/google/auth
 * Variante que redirige directo (si no usa popup). Acepta ?calendar_id=10
 */
router.get('/google/auth', protect, (req, res) => {
  const uid = Number(req.sessionUser?.id_sub_usuario);
  if (!uid) return res.status(401).send('Usuario no autenticado');

  const calendarId = req.query.calendar_id
    ? Number(req.query.calendar_id)
    : null;

  const client = oauth2(getRedirectUri());
  const url = client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: SCOPES,
    state: makeState({ uid, calendarId, redirectAfter: '/panel' }),
  });

  return res.redirect(url);
});

/**
 * GET /api/v1/google/oauth2/callback
 * Intercambia tokens y guarda en users_google_accounts con el calendar_id correcto.
 */
router.get('/google/oauth2/callback', async (req, res) => {
  try {
    const { code, state } = req.query;
    const { uid, calendarId: stateCalendarId } = readState(state);

    const client = oauth2(getRedirectUri());
    const { tokens } = await client.getToken(code);
    client.setCredentials(tokens);

    // Obtener email (userinfo), fallback al id_token
    let googleEmail = null;
    try {
      const oauth2api = google.oauth2({ version: 'v2', auth: client });
      const me = await oauth2api.userinfo.get();
      googleEmail = me?.data?.email || null;
    } catch {}
    if (!googleEmail && tokens.id_token) {
      try {
        const payload = JSON.parse(
          Buffer.from(tokens.id_token.split('.')[1], 'base64').toString('utf8')
        );
        googleEmail = payload?.email || null;
      } catch {}
    }

    // CalendarId efectivo (validado por created_by = id_usuario)
    const effectiveCalendarId = await resolveCalendarId(
      Number(uid),
      Number(stateCalendarId) || null
    );

    // Guardar/actualizar cuenta vinculada
    await db.query(
      `INSERT INTO users_google_accounts
        (id_sub_usuario, calendar_id, google_email, access_token, refresh_token, expiry_date, is_active, revoked_at)
      VALUES (?, ?, ?, ?, ?, ?, 1, NULL)
      ON DUPLICATE KEY UPDATE
      google_email = VALUES(google_email),
      access_token = VALUES(access_token),
      refresh_token = IFNULL(VALUES(refresh_token), refresh_token),
      expiry_date  = VALUES(expiry_date),
      is_active    = 1,
      revoked_at   = NULL`,
      {
        replacements: [
          Number(uid),
          effectiveCalendarId, // <-- calendario de TU tabla
          googleEmail || '',
          tokens.access_token || null,
          tokens.refresh_token || null,
          tokens.expiry_date || null, // si quieres: fallback usando tokens.expires_in
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
 * Para que la UI sepa si está vinculado y con qué correo.
 */
router.get('/google/status', protect, async (req, res) => {
  const uid = Number(req.sessionUser?.id_sub_usuario);
  const calId = Number(req.query.calendar_id);
  if (!uid || !calId)
    return res.status(400).json({ linked: false, google_email: null });

  const rows = await db.query(
    `SELECT google_email, access_token, refresh_token, expiry_date, is_active
       FROM users_google_accounts
      WHERE id_sub_usuario = ? AND calendar_id = ? AND is_active = 1
      LIMIT 1`,
    { replacements: [uid, calId], type: db.QueryTypes.SELECT }
  );

  const row = rows?.[0];
  const linked = !!row && (!!row.access_token || !!row.refresh_token);
  return res.json({ linked, google_email: linked ? row.google_email : null });
});

/**
 * POST /api/v1/google/unlink
 * Desvincula (elimina tokens).
 */
router.post('/google/unlink', protect, async (req, res) => {
  const uid = Number(req.sessionUser?.id_sub_usuario);
  const calId = Number(req.body?.calendar_id);
  if (!uid || !calId)
    return res.status(400).json({ message: 'calendar_id requerido' });

  await db.query(
    `UPDATE users_google_accounts
        SET is_active = 0, revoked_at = NOW(),
            access_token = NULL, refresh_token = NULL, expiry_date = NULL
      WHERE id_sub_usuario = ? AND calendar_id = ?`,
    { replacements: [uid, calId], type: db.QueryTypes.UPDATE }
  );
  return res.json({ status: 'success' });
});

module.exports = router;
