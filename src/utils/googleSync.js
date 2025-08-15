const { google } = require('googleapis');
const { db } = require('../database/config');
const crypto = require('crypto');

function getRedirectUri() {
  const isProd = process.env.NODE_ENV === 'prod';
  return isProd
    ? process.env.GOOGLE_REDIRECT_URI
    : process.env.GOOGLE_REDIRECT_URI_DEV || process.env.GOOGLE_REDIRECT_URI;
}
function oauth2(redirectUri = getRedirectUri()) {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    redirectUri
  );
}

// ===== helpers de cuenta activa por calendario interno =====
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

// ===== mapping local -> Google payload =====
function toGoogleEventPayload(appt) {
  // appt: { title, description, location_text, start_utc, end_utc, booked_tz, meeting_url, status, invitees? }
  const attendees = Array.isArray(appt.invitees)
    ? appt.invitees
        .filter((i) => i.email)
        .map((i) => ({
          email: i.email,
          displayName: i.name || undefined,
        }))
    : [];

  const payload = {
    summary: appt.title || '(Sin título)',
    description: appt.description || undefined,
    location: appt.location_text || undefined,
    start: { dateTime: new Date(appt.start_utc).toISOString() },
    end: { dateTime: new Date(appt.end_utc).toISOString() },
    attendees,
  };

  // Si quisieras autogenerar Google Meet cuando no hay meeting_url:
  // payload.conferenceData = { createRequest: { requestId: crypto.randomUUID() } };

  return payload;
}

// ===== Local -> Google (crear/actualizar/borrar) =====
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

  // Cancelado => eliminar en Google (si existe)
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

  const body = toGoogleEventPayload(appointment);

  try {
    if (map?.google_event_id) {
      const { data } = await gcal.events.patch({
        calendarId: googleCalId,
        eventId: map.google_event_id,
        requestBody: body,
        // conferenceDataVersion: 1,
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
      return { ok: true };
    } else {
      const { data } = await gcal.events.insert({
        calendarId: googleCalId,
        requestBody: body,
        // conferenceDataVersion: 1,
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
      return { ok: true };
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

// ===== Watch (push) Google -> Local =====
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

  // primer pull para obtener sync_token
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

// ===== Pull (Google -> Local) =====
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

  let params = { calendarId: googleCalId, showDeleted: true, maxResults: 100 };
  if (!reset && link.sync_token) params.syncToken = link.sync_token;
  else
    params.timeMin = new Date(
      Date.now() - 90 * 24 * 60 * 60 * 1000
    ).toISOString();

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

  const startISO =
    ev.start?.dateTime ||
    (ev.start?.date ? ev.start.date + 'T00:00:00Z' : null);
  const endISO =
    ev.end?.dateTime || (ev.end?.date ? ev.end.date + 'T00:00:00Z' : null);
  const title = ev.summary || '(Sin título)';
  const desc = ev.description || null;
  const loc = ev.location || null;
  const meet = ev.hangoutLink || null;
  const tz = ev.start?.timeZone || ev.end?.timeZone || 'UTC';

  if (map?.appointment_id) {
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
          startISO,
          endISO,
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
  } else {
    const [res] = await db.query(
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
          startISO,
          endISO,
          tz,
        ],
        type: db.QueryTypes.INSERT,
      }
    );
    const newId = res;
    await db.query(
      `INSERT INTO google_events_links
         (appointment_id, calendar_id, id_sub_usuario, google_event_id, google_etag, is_deleted)
       VALUES (?, ?, ?, ?, ?, 0)`,
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

module.exports = {
  upsertGoogleEvent,
  deleteGoogleEvent,
  startWatch,
  stopWatch,
  importChanges,
  getActiveLink,
};
