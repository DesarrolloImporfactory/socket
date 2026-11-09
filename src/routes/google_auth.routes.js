const express = require('express');
const { google } = require('googleapis');
const { makeState, readState } = require('../utils/googleState');
const { permisoCalendario, olvidarPermiso } = require('../utils/googlePermiso');
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
// function getRedirectUri() {
//   const isProd = process.env.NODE_ENV === 'prod';
//   if (isProd) return process.env.GOOGLE_REDIRECT_URI;
//   return process.env.GOOGLE_REDIRECT_URI_DEV || process.env.GOOGLE_REDIRECT_URI;
// }

function getRedirectUri() {
  return process.env.GOOGLE_REDIRECT_URI;
}

/** Cliente OAuth2 */
function oauth2(redirectUri = getRedirectUri()) {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    redirectUri,
  );
}

/**
 * Obtiene el id_usuario (dueño) a partir del id_sub_usuario.
 */
async function getOwnerUserIdBySub(uid) {
  const row = await db.query(
    `SELECT id_usuario FROM sub_usuarios_chat_center WHERE id_sub_usuario = ? LIMIT 1`,
    { replacements: [uid], type: db.QueryTypes.SELECT },
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
      },
    );
    if (ok?.[0]?.id) return Number(ok[0].id);
  }

  // 2) Tomar el más reciente del mismo owner
  const last = await db.query(
    `SELECT id FROM calendars WHERE created_by = ? ORDER BY id DESC LIMIT 1`,
    { replacements: [ownerUserId], type: db.QueryTypes.SELECT },
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

/* ── Registro de intentos de vinculación ─────────────────────────────────
   El callback no tiene sesión ni UI: cuando fallaba, el usuario veía un
   texto genérico y nosotros solo teníamos el console.error de pm2. UNNICO
   CONSTRUCTORA (2026-11-09) reportó «Error al vincular Google Calendar» y
   no hubo forma de saber desde fuera si el state caducó, si Google devolvió
   access_denied o si el code ya estaba canjeado (los tres daban el mismo
   500). Cada intento, bueno o malo, deja una fila en google_oauth_log con
   el motivo; la tabla se crea sola la primera vez. Fail-open: si el log
   falla, la vinculación sigue. */
let tablaLogLista = false;
async function registrarIntentoOAuth({
  id_sub_usuario,
  calendar_id,
  resultado,
  detalle,
  google_email,
  req,
}) {
  try {
    if (!tablaLogLista) {
      await db.query(`CREATE TABLE IF NOT EXISTS google_oauth_log (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        id_sub_usuario BIGINT UNSIGNED NULL,
        calendar_id BIGINT UNSIGNED NULL,
        resultado VARCHAR(40) NOT NULL,
        detalle VARCHAR(500) NULL,
        google_email VARCHAR(191) NULL,
        ip VARCHAR(64) NULL,
        creado TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        KEY idx_gol_sub (id_sub_usuario, creado)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
      tablaLogLista = true;
    }
    const ip =
      String(req?.headers?.['x-forwarded-for'] || '').split(',')[0].trim() ||
      req?.ip ||
      null;
    await db.query(
      `INSERT INTO google_oauth_log
         (id_sub_usuario, calendar_id, resultado, detalle, google_email, ip)
       VALUES (?, ?, ?, ?, ?, ?)`,
      {
        replacements: [
          id_sub_usuario || null,
          calendar_id || null,
          String(resultado || 'desconocido').slice(0, 40),
          detalle ? String(detalle).slice(0, 500) : null,
          google_email || null,
          ip ? String(ip).slice(0, 64) : null,
        ],
        type: db.QueryTypes.INSERT,
      },
    );
  } catch (e) {
    console.warn('[google-oauth] no se pudo registrar el intento:', e.message);
  }
  console.log(
    `[google-oauth] sub ${id_sub_usuario ?? '?'} cal ${calendar_id ?? '?'}: ${resultado}${detalle ? ` (${detalle})` : ''}`,
  );
}

/* Respuesta del callback: la ve la persona en la pestaña/popup de Google. */
function responderCallback(res, status, titulo, ayuda) {
  res.status(status).type('html');
  return res.send(
    `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>ImporChat · Google Calendar</title>
<meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body style="font-family:system-ui,sans-serif;max-width:520px;margin:48px auto;padding:0 20px;color:#111">
<h2 style="margin:0 0 12px">${titulo}</h2>
${ayuda ? `<p style="margin:0;line-height:1.5;color:#444">${ayuda}</p>` : ''}
</body></html>`,
  );
}

const REINTENTAR =
  'Cierra esta pestaña, vuelve a ImporChat y pulsa «Conectar Google» otra vez. Si Google muestra la pantalla roja de «app no verificada», elige «Configuración avanzada» y luego «Ir a ImporChat (no seguro)».';

/**
 * GET /api/v1/google/oauth2/callback
 * Intercambia tokens y guarda en users_google_accounts con el calendar_id correcto.
 *
 * Los tres fallos que dependen de la persona (state caducado, Google devolvió
 * error=access_denied, code ya canjeado por una recarga) responden 400 con
 * un texto que dice qué hacer; el 500 queda solo para errores nuestros.
 * Todo intento se anota en google_oauth_log (ver registrarIntentoOAuth).
 */
router.get('/google/oauth2/callback', async (req, res) => {
  const { code, state, error: errorGoogle } = req.query;
  let uid = null;
  let stateCalendarId = null;

  // 1) state: quién es y a qué calendario iba
  try {
    const st = readState(state);
    uid = Number(st?.uid) || null;
    stateCalendarId = Number(st?.calendarId) || null;
    if (!uid) throw new Error('state sin uid');
  } catch (e) {
    const caducado = e?.name === 'TokenExpiredError';
    await registrarIntentoOAuth({
      resultado: caducado ? 'state_caducado' : 'state_invalido',
      detalle: e?.message,
      req,
    });
    return responderCallback(
      res,
      400,
      caducado
        ? '⏱️ La autorización tardó demasiado'
        : '⚠️ El enlace de autorización no es válido',
      REINTENTAR,
    );
  }

  // 2) Google no dio código: la persona canceló o Google denegó
  if (errorGoogle || !code) {
    await registrarIntentoOAuth({
      id_sub_usuario: uid,
      calendar_id: stateCalendarId,
      resultado: 'google_denegado',
      detalle: errorGoogle || 'sin code',
      req,
    });
    return responderCallback(
      res,
      400,
      '🚫 No se autorizó el acceso en Google',
      `Google respondió «${String(errorGoogle || 'sin código')}». ${REINTENTAR}`,
    );
  }

  // 3) Canje del code por tokens
  const client = oauth2(getRedirectUri());
  let tokens;
  try {
    ({ tokens } = await client.getToken(code));
  } catch (e) {
    const codigo = e?.response?.data?.error || e?.code || '';
    const desc = e?.response?.data?.error_description || e?.message || '';
    const usado = String(codigo) === 'invalid_grant';
    await registrarIntentoOAuth({
      id_sub_usuario: uid,
      calendar_id: stateCalendarId,
      resultado: usado ? 'code_usado' : 'canje_fallido',
      detalle: `${codigo} ${desc}`.trim(),
      req,
    });
    if (usado) {
      return responderCallback(
        res,
        400,
        '🔁 Esta autorización ya se usó',
        `Google solo acepta cada autorización una vez (pasa al recargar esta pestaña). ${REINTENTAR}`,
      );
    }
    console.error('[google-oauth] canje fallido:', codigo, desc);
    return responderCallback(
      res,
      500,
      '❌ Error al vincular Google Calendar',
      `Google no entregó los tokens (${String(codigo || desc).slice(0, 120)}). ${REINTENTAR}`,
    );
  }

  try {
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
          Buffer.from(tokens.id_token.split('.')[1], 'base64').toString('utf8'),
        );
        googleEmail = payload?.email || null;
      } catch {}
    }

    // CalendarId efectivo (validado por created_by = id_usuario)
    const effectiveCalendarId = await resolveCalendarId(uid, stateCalendarId);

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
          uid,
          effectiveCalendarId, // <-- calendario de TU tabla
          googleEmail || '',
          tokens.access_token || null,
          tokens.refresh_token || null,
          tokens.expiry_date || null, // (si no viene, puedes derivarlo de expires_in)
        ],
        type: db.QueryTypes.INSERT,
      },
    );

    try {
      const [l] = await db.query(
        `SELECT id FROM users_google_accounts WHERE id_sub_usuario = ? AND calendar_id = ? LIMIT 1`,
        { replacements: [uid, effectiveCalendarId], type: db.QueryTypes.SELECT },
      );
      if (l?.id) olvidarPermiso(l.id);
    } catch (_) {}

    // 🔌 AÑADIDO: al vincular, inicia el canal watch (si tu googleSync lo maneja internamente)
    try {
      await startWatch({
        id_sub_usuario: uid,
        calendar_id: Number(effectiveCalendarId),
      });
    } catch (e) {
      console.warn('startWatch warning:', e?.message || e);
      // No interrumpimos la vinculación por un fallo de watch
    }

    await registrarIntentoOAuth({
      id_sub_usuario: uid,
      calendar_id: effectiveCalendarId,
      resultado: 'ok',
      detalle: effectiveCalendarId ? null : 'sin calendario propio (calendar_id NULL)',
      google_email: googleEmail,
      req,
    });

    return responderCallback(
      res,
      200,
      '✅ Google Calendar vinculado',
      `Cuenta ${googleEmail || 'de Google'} conectada. Ya puedes cerrar esta pestaña.`,
    );
  } catch (e) {
    console.error('[google-oauth] error guardando la vinculación:', e);
    await registrarIntentoOAuth({
      id_sub_usuario: uid,
      calendar_id: stateCalendarId,
      resultado: 'error_interno',
      detalle: e?.message,
      req,
    });
    return responderCallback(
      res,
      500,
      '❌ Error al vincular Google Calendar',
      `Google autorizó pero no pudimos guardar la vinculación. ${REINTENTAR}`,
    );
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
    `SELECT id, google_email, access_token, refresh_token, expiry_date, is_active
       FROM users_google_accounts
      WHERE id_sub_usuario = ? AND calendar_id = ? AND is_active = 1
      LIMIT 1`,
    { replacements: [uid, calId], type: db.QueryTypes.SELECT },
  );

  const row = rows?.[0];
  const linked = !!row && (!!row.access_token || !!row.refresh_token);
  /* «Conectado» no basta: si al autorizar no aceptó el permiso de calendario,
     Google rechaza cada evento con 403 y la pantalla decía que todo estaba
     bien (Juan Garzón, 2026-11-04). Se informa para que la UI pida volver a
     vincular. */
  const calendar_scope = linked ? await permisoCalendario(row) : null;
  return res.json({
    linked,
    google_email: linked ? row.google_email : null,
    calendar_scope,
  });
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
    { replacements: [uid, calId], type: db.QueryTypes.UPDATE },
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

/**
 * GET /api/v1/google/is-linked
 * Retorna si el sub_usuario tiene ALGUNA cuenta Google activa
 */
router.get('/google/is-linked', protect, async (req, res) => {
  const uid = Number(req.sessionUser?.id_sub_usuario);
  if (!uid) return res.json({ linked: false });

  const rows = await db.query(
    `SELECT google_email FROM users_google_accounts
     WHERE id_sub_usuario = ? AND is_active = 1
       AND (access_token IS NOT NULL OR refresh_token IS NOT NULL)
     LIMIT 1`,
    { replacements: [uid], type: db.QueryTypes.SELECT },
  );

  const row = rows?.[0];
  return res.json({
    linked: !!row,
    google_email: row?.google_email || null,
  });
});

module.exports = router;
