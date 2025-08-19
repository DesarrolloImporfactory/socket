/*
 * -------------------------------------------------------------
 * Sincronización bidireccional con Google Calendar:
 *  - PUSH (local → Google): crea/actualiza/elimina eventos.
 *  - PULL (Google → local): importa cambios (watch + list con syncToken).
 * -------------------------------------------------------------
 */

const { google } = require('googleapis');
const { db } = require('../database/config');
const Appointment = require('../models/appointment.model');
const AppointmentInvitee = require('../models/appointment_invitee.model');
const Calendar = require('../models/calendar.model');
const crypto = require('crypto');
require('dotenv').config();

/* ===================== OAuth helpers ===================== */

function getRedirectUri() {
  return process.env.GOOGLE_REDIRECT_URI;
}

function oauth2(redirectUri = getRedirectUri()) {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    redirectUri
  );
}

/* ===================== Helpers de fechas (PULL) ===================== */

/**
 * Convierte la estructura de Google ({dateTime,timeZone} o {date}) a Date (UTC).
 * - dateTime ISO (con Z u offset) → Date correcto
 * - date all-day → 00:00:00 UTC del día
 */
function parseGoogleTime(g) {
  if (g?.dateTime) return new Date(g.dateTime);
  if (g?.date) return new Date(g.date + 'T00:00:00Z');
  return null;
}

/**
 * Devuelve 'YYYY-MM-DD HH:MM:SS' en UTC para guardar en DB (DATETIME).
 */
function toMysqlDateTime(v) {
  const d = v instanceof Date ? v : new Date(v);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

/* ===================== Helpers de fechas (PUSH) ===================== */
/**
 * Determina si una cadena ISO trae offset explícito (±HH:MM) o 'Z'.
 */
function hasTZOffset(s) {
  return typeof s === 'string' && (/[+-]\d{2}:\d{2}$/.test(s) || /Z$/i.test(s));
}

/**
 * Convierte 'YYYY-MM-DD HH:MM:SS' → 'YYYY-MM-DDTHH:MM:SS' (no añade Z).
 */
function asIsoNoT(s) {
  return typeof s === 'string' ? s.replace(' ', 'T') : s;
}

/**
 * Construye el campo de fecha para Google:
 * - Si viene `fromFront` con offset → { dateTime: fromFront } (sin timeZone).
 * - Si viene `fromFront` sin offset  → { dateTime: fromFront, timeZone: tz }.
 * - Si no viene `fromFront`, usa `fromDb`:
 *   - fromDb instanceof Date → { dateTime: fromDb.toISOString() } (UTC correcta).
 *   - fromDb string con offset/Z → { dateTime: fromDb }.
 *   - fromDb string 'YYYY-MM-DD HH:MM:SS' (UTC en DB) → { dateTime: '<iso>Z' }.
 */
function buildGoogleDateField({ fromFront, tz, fromDb }) {
  // 1) Preferimos lo que envía el front
  if (fromFront) {
    if (typeof fromFront === 'string') {
      const iso = asIsoNoT(fromFront);
      if (hasTZOffset(iso)) return { dateTime: iso };
      return { dateTime: iso, timeZone: tz || 'UTC' };
    }
    if (fromFront instanceof Date) {
      return { dateTime: fromFront.toISOString() };
    }
  }

  // 2) Fallback a lo que tengamos en la DB
  if (fromDb instanceof Date) {
    // Date representa un instante absoluto → ISO con Z correcto
    return { dateTime: fromDb.toISOString() };
  }
  if (typeof fromDb === 'string') {
    const iso = asIsoNoT(fromDb);
    if (hasTZOffset(iso)) {
      // ya trae offset o Z
      return { dateTime: iso };
    }
    // Caso típico DB: 'YYYY-MM-DD HH:MM:SS' guardado como UTC (start_utc/end_utc)
    // añadimos 'Z' para que Google lo interprete en UTC
    return { dateTime: iso + 'Z' };
  }

  return undefined;
}

/* ===================== Vínculos de cuenta/cliente Google ===================== */

async function getActiveLink(id_sub_usuario, calendar_id) {
  const rows = await db.query(
    `SELECT *
       FROM users_google_accounts
      WHERE id_sub_usuario = ? AND calendar_id = ? AND is_active = 1
      LIMIT 1`,
    { replacements: [id_sub_usuario, calendar_id], type: db.QueryTypes.SELECT }
  );
  return rows[0] || null;
}

async function getOAuthClientForLink(link) {
  if (!link || !link.refresh_token) return null;
  const client = oauth2(getRedirectUri());
  client.setCredentials({
    access_token: link.access_token || undefined,
    refresh_token: link.refresh_token,
    expiry_date: link.expiry_date || undefined,
  });
  client.on('tokens', async (tokens) => {
    try {
      await db.query(
        `UPDATE users_google_accounts
            SET access_token = IFNULL(?, access_token),
                expiry_date  = IFNULL(?, expiry_date)
          WHERE id = ?`,
        {
          replacements: [
            tokens.access_token || null,
            tokens.expiry_date || null,
            link.id,
          ],
          type: db.QueryTypes.UPDATE,
        }
      );
    } catch (e) {
      console.error('persist tokens error', e);
    }
  });
  return client;
}

/* ===================== Mapping local → Google (PUSH) ===================== */
/**
 * Construye el requestBody para gcal.events.insert/patch respetando prioridad:
 *   1) appt.__override.start / appt.__override.end / appt.__override.timeZone (vienen del servicio)
 *   2) appt.booked_tz
 *   3) fallback a valores de DB (start_utc/end_utc)
 */
function toGoogleEventPayload(appt) {
  const attendees = Array.isArray(appt.invitees)
    ? appt.invitees
        .filter((i) => i.email)
        .map((i) => ({
          email: i.email,
          displayName: i.name || undefined,
        }))
    : [];

  const tz = appt.__override?.timeZone || appt.booked_tz || 'UTC';

  const startField = buildGoogleDateField({
    fromFront: appt.__override?.start,
    tz,
    fromDb: appt.start_utc,
  });

  const endField = buildGoogleDateField({
    fromFront: appt.__override?.end,
    tz,
    fromDb: appt.end_utc,
  });

  const payload = {
    summary: appt.title || '(Sin título)',
    description: appt.description || undefined,
    location: appt.location_text || undefined,
    start: startField,
    end: endField,
    attendees,
  };

  // Si no hay meeting_url y se pide crear Meet, añade conferenceData
  if (!appt.meeting_url && appt.create_meet) {
    payload.conferenceData = {
      createRequest: {
        requestId: crypto.randomUUID(),
        conferenceSolutionKey: { type: 'hangoutsMeet' },
      },
    };
  }

  // Log mínimo de auditoría (útil si hay dudas de TZ)
  // console.log('[gcal push] start:', payload.start, 'end:', payload.end, 'tz=', tz);

  return payload;
}

/* ===================== Local → Google (crear/actualizar/borrar) ===================== */

async function upsertGoogleEvent({ id_sub_usuario, calendar_id, appointment }) {
  const link = await getActiveLink(id_sub_usuario, calendar_id);
  if (!link) return { ok: false, reason: 'no_link' };

  const client = await getOAuthClientForLink(link);
  if (!client) return { ok: false, reason: 'no_client' };
  const gcal = google.calendar({ version: 'v3', auth: client });
  const googleCalId = link.google_calendar_id || 'primary';

  // ¿ya existe mapeo?
  const [map] = await db.query(
    `SELECT id, google_event_id FROM google_events_links WHERE appointment_id = ? LIMIT 1`,
    { replacements: [appointment.id], type: db.QueryTypes.SELECT }
  );

  // Si está cancelado, borra en Google
  if (appointment.status === 'Cancelado') {
    if (map?.google_event_id) {
      try {
        await gcal.events.delete({
          calendarId: googleCalId,
          eventId: map.google_event_id,
        });
      } catch (e) {
        if (![404, 410].includes(e?.code))
          console.error('delete error', e?.response?.data || e.message);
      }
      await db.query(
        `UPDATE google_events_links SET is_deleted = 1, last_synced_at = NOW() WHERE id = ?`,
        { replacements: [map.id], type: db.QueryTypes.UPDATE }
      );
    }
    return { ok: true };
  }

  const requestBody = toGoogleEventPayload(appointment);

  try {
    if (map?.google_event_id) {
      // PATCH
      const { data } = await gcal.events.patch({
        calendarId: googleCalId,
        eventId: map.google_event_id,
        requestBody,
        conferenceDataVersion: 1,
      });
      await db.query(
        `UPDATE google_events_links
            SET google_etag = ?, is_deleted = 0, last_synced_at = NOW()
          WHERE id = ?`,
        {
          replacements: [data.etag || null, map.id],
          type: db.QueryTypes.UPDATE,
        }
      );
      if (!appointment.meeting_url && data.hangoutLink) {
        await db.query(`UPDATE appointments SET meeting_url = ? WHERE id = ?`, {
          replacements: [data.hangoutLink, appointment.id],
          type: db.QueryTypes.UPDATE,
        });
      }
      return {
        ok: true,
        eventId: data.id,
        etag: data.etag || null,
        meetingUrl: data.hangoutLink || null,
      };
    } else {
      // INSERT
      const { data } = await gcal.events.insert({
        calendarId: googleCalId,
        requestBody,
        conferenceDataVersion: 1,
      });
      await db.query(
        `INSERT INTO google_events_links
           (appointment_id, calendar_id, id_sub_usuario, google_event_id, google_etag, is_deleted)
         VALUES (?, ?, ?, ?, ?, 0)
         ON DUPLICATE KEY UPDATE
           google_event_id = VALUES(google_event_id),
           google_etag = VALUES(google_etag),
           is_deleted = 0,
           last_synced_at = NOW()`,
        {
          replacements: [
            appointment.id,
            calendar_id,
            id_sub_usuario,
            data.id,
            data.etag || null,
          ],
          type: db.QueryTypes.INSERT,
        }
      );
      if (!appointment.meeting_url && data.hangoutLink) {
        await db.query(`UPDATE appointments SET meeting_url = ? WHERE id = ?`, {
          replacements: [data.hangoutLink, appointment.id],
          type: db.QueryTypes.UPDATE,
        });
      }
      return {
        ok: true,
        eventId: data.id,
        etag: data.etag || null,
        meetingUrl: data.hangoutLink || null,
      };
    }
  } catch (e) {
    console.error('upsertGoogleEvent error', e?.response?.data || e.message);
    return {
      ok: false,
      reason: 'api_error',
      error: e?.response?.data || e.message,
    };
  }
}

async function deleteGoogleEvent({
  id_sub_usuario,
  calendar_id,
  appointment_id,
}) {
  const link = await getActiveLink(id_sub_usuario, calendar_id);
  if (!link) return { ok: false, reason: 'no_link' };
  const client = await getOAuthClientForLink(link);
  if (!client) return { ok: false, reason: 'no_client' };
  const gcal = google.calendar({ version: 'v3', auth: client });
  const googleCalId = link.google_calendar_id || 'primary';

  const [map] = await db.query(
    `SELECT id, google_event_id FROM google_events_links WHERE appointment_id = ? LIMIT 1`,
    { replacements: [appointment_id], type: db.QueryTypes.SELECT }
  );
  if (!map) return { ok: true };

  try {
    await gcal.events.delete({
      calendarId: googleCalId,
      eventId: map.google_event_id,
    });
  } catch (e) {
    if (![404, 410].includes(e?.code))
      console.error('deleteGoogleEvent error', e?.response?.data || e.message);
  }
  await db.query(
    `UPDATE google_events_links SET is_deleted = 1, last_synced_at = NOW() WHERE id = ?`,
    { replacements: [map.id], type: db.QueryTypes.UPDATE }
  );
  return { ok: true };
}

/* ===================== Watch (push) Google → Local ===================== */

async function startWatch({ id_sub_usuario, calendar_id }) {
  const link = await getActiveLink(id_sub_usuario, calendar_id);
  if (!link) return { ok: false, reason: 'no_link' };
  const client = await getOAuthClientForLink(link);
  if (!client) return { ok: false, reason: 'no_client' };

  const gcal = google.calendar({ version: 'v3', auth: client });
  const googleCalId = link.google_calendar_id || 'primary';

  const channelId = crypto.randomUUID();
  const address = process.env.GOOGLE_PUSH_WEBHOOK_URL;

  const { data } = await gcal.events.watch({
    calendarId: googleCalId,
    requestBody: { id: channelId, type: 'web_hook', address },
  });

  await db.query(
    `UPDATE users_google_accounts
        SET watch_channel_id = ?, watch_resource_id = ?, watch_expiration = ?, sync_token = NULL
      WHERE id = ?`,
    {
      replacements: [
        data.id || channelId,
        data.resourceId || null,
        data.expiration || null,
        link.id,
      ],
      type: db.QueryTypes.UPDATE,
    }
  );

  // Primer pull para obtener sync_token
  await importChanges({ linkId: link.id, reset: true });
  return { ok: true };
}

async function stopWatch({ id_sub_usuario, calendar_id }) {
  const link = await getActiveLink(id_sub_usuario, calendar_id);
  if (!link || !link.watch_channel_id) return { ok: true };
  const client = await getOAuthClientForLink(link);
  if (!client) return { ok: true };
  const gcal = google.calendar({ version: 'v3', auth: client });

  try {
    await gcal.channels.stop({
      requestBody: {
        id: link.watch_channel_id,
        resourceId: link.watch_resource_id,
      },
    });
  } catch {}
  await db.query(
    `UPDATE users_google_accounts
        SET watch_channel_id = NULL, watch_resource_id = NULL, watch_expiration = NULL
      WHERE id = ?`,
    { replacements: [link.id], type: db.QueryTypes.UPDATE }
  );
  return { ok: true };
}

/* ===================== Pull (Google → Local) ===================== */

async function importChanges({ linkId, reset = false }) {
  const [link] = await db.query(
    `SELECT * FROM users_google_accounts WHERE id = ? LIMIT 1`,
    { replacements: [linkId], type: db.QueryTypes.SELECT }
  );
  if (!link) return { ok: false, reason: 'no_link' };

  const client = await getOAuthClientForLink(link);
  if (!client) return { ok: false, reason: 'no_client' };

  const gcal = google.calendar({ version: 'v3', auth: client });
  const googleCalId = link.google_calendar_id || 'primary';

  // TZ de referencia para el pull (mejora consistencia)
  let calendarTz = 'America/Guayaquil';
  try {
    const [calRow] = await db.query(
      `SELECT time_zone FROM calendars WHERE id = ? LIMIT 1`,
      { replacements: [link.calendar_id], type: db.QueryTypes.SELECT }
    );
    if (calRow?.time_zone) calendarTz = calRow.time_zone;
  } catch {}

  let params = {
    calendarId: googleCalId,
    showDeleted: true,
    maxResults: 100,
    timeZone: calendarTz,
  };

  if (!reset && link.sync_token) {
    params.syncToken = link.sync_token;
  } else {
    params.timeMin = new Date(
      Date.now() - 90 * 24 * 60 * 60 * 1000
    ).toISOString();
  }

  try {
    let nextPageToken = null;
    let nextSyncToken = null;
    do {
      const { data } = await gcal.events.list({
        ...params,
        pageToken: nextPageToken || undefined,
      });
      nextPageToken = data.nextPageToken || null;
      nextSyncToken = data.nextSyncToken || nextSyncToken;
      const items = Array.isArray(data.items) ? data.items : [];
      for (const ev of items) await applyGoogleEventToLocal({ link, ev });
    } while (nextPageToken);

    if (nextSyncToken) {
      await db.query(
        `UPDATE users_google_accounts SET sync_token = ? WHERE id = ?`,
        { replacements: [nextSyncToken, link.id], type: db.QueryTypes.UPDATE }
      );
    }
    return { ok: true };
  } catch (e) {
    if (e?.code === 410) {
      // token inválido → reset
      await db.query(
        `UPDATE users_google_accounts SET sync_token = NULL WHERE id = ?`,
        { replacements: [link.id], type: db.QueryTypes.UPDATE }
      );
      return importChanges({ linkId: link.id, reset: true });
    }
    console.error('importChanges error', e?.response?.data || e.message);
    return { ok: false, error: e?.response?.data || e.message };
  }
}

/* ========== Aplicar un evento de Google en la DB local (PULL) ========== */

async function applyGoogleEventToLocal({ link, ev }) {
  const isDeleted = ev.status === 'cancelled';
  const googleId = ev.id;

  const [map] = await db.query(
    `SELECT * FROM google_events_links WHERE google_event_id = ? LIMIT 1`,
    { replacements: [googleId], type: db.QueryTypes.SELECT }
  );

  if (isDeleted) {
    if (map?.appointment_id) {
      await db.query(
        `UPDATE appointments SET status = 'Cancelado' WHERE id = ?`,
        { replacements: [map.appointment_id], type: db.QueryTypes.UPDATE }
      );
      await db.query(
        `UPDATE google_events_links SET is_deleted = 1, last_synced_at = NOW() WHERE id = ?`,
        { replacements: [map.id], type: db.QueryTypes.UPDATE }
      );
    }
    return;
  }

  // Normaliza tiempos de Google → UTC para DB
  const startDate = parseGoogleTime(ev.start); // Date (UTC)
  let endDate = parseGoogleTime(ev.end);
  if (!endDate && startDate)
    endDate = new Date(startDate.getTime() + 30 * 60000);

  const startMy = toMysqlDateTime(startDate);
  const endMy = toMysqlDateTime(endDate);

  const title = ev.summary || '(Sin título)';
  const desc = ev.description || null;
  const loc = ev.location || null;
  const meet = ev.hangoutLink || null;
  const tz = ev.start?.timeZone || ev.end?.timeZone || 'UTC';

  const rawAttendees = Array.isArray(ev.attendees) ? ev.attendees : [];
  const attendees = rawAttendees
    .filter((a) => a?.email)
    .map((a) => ({
      email: String(a.email).toLowerCase(),
      name: a.displayName || null,
      phone: null,
      response_status: (() => {
        const s = (a.responseStatus || '').toLowerCase();
        if (s === 'accepted') return 'accepted';
        if (s === 'declined') return 'declined';
        if (s === 'tentative') return 'tentative';
        return 'needsAction';
      })(),
    }));

  if (map?.appointment_id) {
    // UPDATE local
    await db.query(
      `UPDATE appointments
          SET title = ?, description = ?, location_text = ?,
              meeting_url = COALESCE(?, meeting_url),
              start_utc = ?, end_utc = ?, booked_tz = ?
        WHERE id = ?`,
      {
        replacements: [
          title,
          desc,
          loc,
          meet,
          startMy,
          endMy,
          tz,
          map.appointment_id,
        ],
        type: db.QueryTypes.UPDATE,
      }
    );

    await db.query(
      `UPDATE google_events_links SET google_etag = ?, is_deleted = 0, last_synced_at = NOW() WHERE id = ?`,
      { replacements: [ev.etag || null, map.id], type: db.QueryTypes.UPDATE }
    );

    // Upsert de invitados por email
    if (attendees.length) {
      const current = await db.query(
        `SELECT id, email FROM appointment_invitees WHERE appointment_id = ?`,
        { replacements: [map.appointment_id], type: db.QueryTypes.SELECT }
      );

      const byEmail = new Map(
        current.map((i) => [String(i.email || '').toLowerCase(), i])
      );
      const kept = new Set();

      for (const a of attendees) {
        const exists = byEmail.get(a.email);
        if (exists) {
          await db.query(
            `UPDATE appointment_invitees
               SET name = ?, response_status = ?
             WHERE id = ?`,
            {
              replacements: [a.name, a.response_status, exists.id],
              type: db.QueryTypes.UPDATE,
            }
          );
          kept.add(exists.id);
        } else {
          const [iid] = await db.query(
            `INSERT INTO appointment_invitees
               (appointment_id, name, email, phone, response_status)
             VALUES (?, ?, ?, ?, ?)`,
            {
              replacements: [
                map.appointment_id,
                a.name,
                a.email,
                a.phone,
                a.response_status,
              ],
              type: db.QueryTypes.INSERT,
            }
          );
          kept.add(iid);
        }
      }

      // (Opcional) eliminar los que ya no vienen en Google
      const toRemove = current.filter((i) => !kept.has(i.id));
      if (toRemove.length) {
        await db.query(
          `DELETE FROM appointment_invitees WHERE id IN (${toRemove
            .map(() => '?')
            .join(',')})`,
          {
            replacements: toRemove.map((i) => i.id),
            type: db.QueryTypes.DELETE,
          }
        );
      }

      // Asegurar contact_id si está vacío
      await db.query(
        `UPDATE appointments
           SET contact_id = COALESCE(contact_id,
             (SELECT id FROM appointment_invitees WHERE appointment_id = ? ORDER BY id ASC LIMIT 1)
           )
         WHERE id = ?`,
        {
          replacements: [map.appointment_id, map.appointment_id],
          type: db.QueryTypes.UPDATE,
        }
      );
    }
  } else {
    // INSERT local
    const [insertId] = await db.query(
      `INSERT INTO appointments
         (calendar_id, title, description, location_text, meeting_url,
          start_utc, end_utc, booked_tz, status, created_by_user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'Agendado', NULL)`,
      {
        replacements: [
          link.calendar_id,
          title,
          desc,
          loc,
          meet,
          startMy,
          endMy,
          tz,
        ],
        type: db.QueryTypes.INSERT,
      }
    );
    const newId = insertId;

    // Invitados
    let firstInviteeId = null;
    for (const [idx, a] of attendees.entries()) {
      const [iid] = await db.query(
        `INSERT INTO appointment_invitees (appointment_id, name, email, phone, response_status)
         VALUES (?, ?, ?, ?, ?)`,
        {
          replacements: [newId, a.name, a.email, a.phone, a.response_status],
          type: db.QueryTypes.INSERT,
        }
      );
      if (idx === 0) firstInviteeId = iid;
    }
    if (firstInviteeId) {
      await db.query(`UPDATE appointments SET contact_id = ? WHERE id = ?`, {
        replacements: [firstInviteeId, newId],
        type: db.QueryTypes.UPDATE,
      });
    }

    await db.query(
      `INSERT INTO google_events_links
         (appointment_id, calendar_id, id_sub_usuario, google_event_id, google_etag, is_deleted, last_synced_at)
       VALUES (?, ?, ?, ?, ?, 0, NOW())
       ON DUPLICATE KEY UPDATE
         appointment_id = VALUES(appointment_id),
         google_etag = VALUES(google_etag),
         is_deleted = 0,
         last_synced_at = NOW()`,
      {
        replacements: [
          newId,
          link.calendar_id,
          link.id_sub_usuario,
          googleId,
          ev.etag || null,
        ],
        type: db.QueryTypes.INSERT,
      }
    );
  }
}

/* ===================== Resolver vínculo por headers (webhook) ===================== */

async function findLinkByHeaders({ channelId, resourceId }) {
  const rows = await db.query(
    `SELECT * FROM users_google_accounts
      WHERE watch_channel_id = ? AND watch_resource_id = ?
      LIMIT 1`,
    { replacements: [channelId, resourceId], type: db.QueryTypes.SELECT }
  );
  return rows?.[0] || null;
}

/* ===================== Facades usadas por tu servicio ===================== */
/**
 * pushUpsertEvent
 * Permite pasar overrides desde el servicio (create/update):
 *   - start, end: cadenas ISO (idealmente con offset, p.ej. ...-05:00) o Date
 *   - timeZone: 'America/Guayaquil', etc.
 */
async function pushUpsertEvent({
  appointmentId,
  createMeet = false,
  start,
  end,
  timeZone,
}) {
  // Cargamos la cita con invitados (como antes)
  const appt = await Appointment.findByPk(appointmentId, {
    include: [
      {
        model: AppointmentInvitee,
        as: 'invitees',
        attributes: ['id', 'name', 'email', 'phone', 'response_status'],
      },
      { model: Calendar, as: 'calendar', attributes: ['id'] },
    ],
  });
  if (!appt) throw new Error('appointment not found');

  // Dueño para la cuenta de Google (misma regla que tenías)
  const id_sub_usuario =
    appt.assigned_user_id || appt.created_by_user_id || null;

  const payload = {
    ...appt.get({ plain: true }),
    create_meet: createMeet || !appt.meeting_url,
  };

  // Inyecta overrides si llegaron desde el servicio
  if (start || end || timeZone) {
    payload.__override = { start, end, timeZone };
  }

  return upsertGoogleEvent({
    id_sub_usuario,
    calendar_id: appt.calendar_id,
    appointment: payload,
  });
}

async function pushCancelEvent({ appointmentId }) {
  const appt = await Appointment.findByPk(appointmentId);
  if (!appt) throw new Error('appointment not found');

  const id_sub_usuario =
    appt.assigned_user_id || appt.created_by_user_id || null;

  return deleteGoogleEvent({
    id_sub_usuario,
    calendar_id: appt.calendar_id,
    appointment_id: appointmentId,
  });
}

/* ===================== Exports ===================== */
module.exports = {
  upsertGoogleEvent,
  deleteGoogleEvent,
  startWatch,
  stopWatch,
  importChanges,
  getActiveLink,
  findLinkByHeaders,
  pushUpsertEvent,
  pushCancelEvent,
};
