const express = require('express');
const { google } = require('googleapis');
const { makeState, readState } = require('../utils/googleState');
const { db } = require('../database/config');
const { protect } = require('../middlewares/auth.middleware');
require('dotenv').config();

const {
  startWatch,
  stopWatch,
  importChanges,
  getActiveLink,
  findLinkByHeaders,
} = require('../utils/googleSync');

const router = express.Router();

const SCOPES = [
  'openid',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
  'https://www.googleapis.com/auth/calendar',
];

/** Redirect según entorno */
function getRedirectUri() {
  const isProd = process.env.NODE_ENV === 'prod';
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
          tokens.expiry_date || null, // (si no viene, puedes derivarlo de expires_in)
        ],
        type: db.QueryTypes.INSERT,
      }
    );

    // 🔌 AÑADIDO: al vincular, inicia el canal watch (si tu googleSync lo maneja internamente)
    try {
      await startWatch({
        id_sub_usuario: Number(uid),
        calendar_id: Number(effectiveCalendarId),
      });
    } catch (e) {
      console.warn('startWatch warning:', e?.message || e);
      // No interrumpimos la vinculación por un fallo de watch
    }

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
 * Acepta ?calendar_id= (tu id local de calendars)
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
 * Desvincula (elimina tokens). Body: { calendar_id }
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

  // 🔌 AÑADIDO: detener watch (best-effort)
  try {
    await stopWatch({ id_sub_usuario: uid, calendar_id: calId });
  } catch (e) {
    console.warn('stopWatch warning:', e?.message || e);
  }

  return res.json({ status: 'success' });
});

/* ===========================================================
   RUTAS NUEVAS (para controlar watch/sync vía googleSync
   =========================================================== */

/**
 * POST /api/v1/google/watch/start
 * Body: { calendar_id }
 */
router.post('/google/watch/start', protect, async (req, res) => {
  const uid = Number(req.sessionUser?.id_sub_usuario);
  const calId = Number(req.body?.calendar_id);
  if (!uid || !calId)
    return res.status(400).json({ message: 'calendar_id requerido' });

  const r = await startWatch({ id_sub_usuario: uid, calendar_id: calId });
  res.json(r);
});

/**
 * POST /api/v1/google/watch/stop
 * Body: { calendar_id }
 */
router.post('/google/watch/stop', protect, async (req, res) => {
  const uid = Number(req.sessionUser?.id_sub_usuario);
  const calId = Number(req.body?.calendar_id);
  if (!uid || !calId)
    return res.status(400).json({ message: 'calendar_id requerido' });

  const r = await stopWatch({ id_sub_usuario: uid, calendar_id: calId });
  res.json(r);
});

/**
 * POST /api/v1/google/sync/pull
 * Body: { calendar_id, reset?: boolean }
 * Fuerza una importación (pull) desde Google → tu DB (appointments).
 */
router.post('/google/sync/pull', protect, async (req, res) => {
  const uid = Number(req.sessionUser?.id_sub_usuario);
  const calId = Number(req.body?.calendar_id);
  if (!uid || !calId)
    return res.status(400).json({ message: 'calendar_id requerido' });

  const link = await getActiveLink(uid, calId);
  if (!link)
    return res.status(404).json({
      ok: false,
      message: 'No hay vínculo activo para este calendario',
    });

  const r = await importChanges({ linkId: link.id, reset: !!req.body?.reset });
  res.json(r);
});

/**
 * POST /api/v1/google/push
 * Webhook público (Google → nosotros).
 * Lee headers: X-Goog-Channel-Id, X-Goog-Resource-Id
 */
router.post('/google/push', async (req, res) => {
  try {
    const channelId = req.header('X-Goog-Channel-Id');
    const resourceId = req.header('X-Goog-Resource-Id');

    // Google manda "sync" en primera notificación vacía
    // const resourceState = req.header('X-Goog-Resource-State'); // opcional

    if (!channelId || !resourceId) return res.status(200).end();

    // Delega la resolución al módulo de sync (no acoplamos SQL aquí)
    const link = await findLinkByHeaders({ channelId, resourceId });
    if (link?.id) {
      await importChanges({ linkId: link.id, reset: false });
    }

    return res.status(200).end();
  } catch (e) {
    console.error('google/push error:', e?.message || e);
    // Google solo exige 2xx; no reintenta si devolvemos 500
    return res.status(200).end();
  }
});

module.exports = router;
