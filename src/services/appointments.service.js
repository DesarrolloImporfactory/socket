/* -----------------------------------------------------------------------
   Servicio de Citas (Appointments)
   - Valida solapes
   - CRUD de citas
   - Maneja invitados y actualiza contact_id ↔ appointment_invitees
   ----------------------------------------------------------------------- */
const { Op } = require('sequelize');
const Appointment = require('../models/appointment.model');
const AppointmentInvitee = require('../models/appointment_invitee.model');
const Calendar = require('../models/calendar.model');
const AppError = require('../utils/appError');
const { db } = require('../database/config');

const { pushUpsertEvent, pushCancelEvent } = require('../utils/googleSync');

/* ╔═══════════════════════════════════════════════════════════════════════╗
   ║ 1. VERIFY OVERLAPS                                                   ║
   ╚═══════════════════════════════════════════════════════════════════════╝ */
async function assertNoOverlap({
  calendar_id,
  start_utc,
  end_utc,
  ignoreId = null, // ← al actualizar excluimos la propia cita
  /* assigned_user_id */ // ← descomenta si quieres solape por usuario
}) {
  const where = {
    calendar_id,
    status: { [Op.in]: ['Agendado', 'Confirmado', 'Bloqueado'] },
    start_utc: { [Op.lt]: end_utc }, // empieza antes de que termine la nueva
    end_utc: { [Op.gt]: start_utc }, // termina después de que empieza la nueva
  };
  if (ignoreId) where.id = { [Op.ne]: ignoreId };
  // if (assigned_user_id != null) where.assigned_user_id = assigned_user_id;

  const conflict = await Appointment.findOne({ where });
  if (conflict)
    throw new AppError('Conflicto de horario en el calendario.', 409);
}

/* ================= ENGANCHE: push out (evita bucles) ================= */
async function syncOutUpsert(appt, opts) {
  // si el cambio proviene de Google (pull webhook), no empujar de vuelta
  if (opts?.source === 'google') return;

  try {
    const res = await pushUpsertEvent({ appointmentId: appt.id });
    // guarda metadatos si existen las columnas
    if (res && (res.eventId || res.etag)) {
      try {
        await appt.update({
          google_event_id: res.eventId ?? appt.google_event_id ?? null,
          google_etag: res.etag ?? appt.google_etag ?? null,
          last_synced_at: new Date(),
          last_sync_error: null,
        });
      } catch (_) {}
    } else {
      try {
        await appt.update({
          last_synced_at: new Date(),
          last_sync_error: null,
        });
      } catch (_) {}
    }
  } catch (e) {
    try {
      await appt.update({ last_sync_error: e.message || String(e) });
    } catch (_) {}
    console.warn('Google push upsert failed:', e?.message || e);
  }
}

async function syncOutCancel(appt, opts) {
  if (opts?.source === 'google') return;

  try {
    await pushCancelEvent({ appointmentId: appt.id });
    try {
      await appt.update({ last_synced_at: new Date(), last_sync_error: null });
    } catch (_) {}
  } catch (e) {
    try {
      await appt.update({ last_sync_error: e.message || String(e) });
    } catch (_) {}
    console.warn('Google push cancel failed:', e?.message || e);
  }
}

/* ╔═══════════════════════════════════════════════════════════════════════╗
   ║ 2. LIST                                                             ║
   ╚═══════════════════════════════════════════════════════════════════════╝ */
async function listAppointments({
  calendar_id,
  start,
  end,
  user_ids,
  include_unassigned,
}) {
  const where = { calendar_id };

  // ── Rango de fechas (intersección) ──────────────────────────────
  if (start && end) {
    where.start_utc = { [Op.lt]: end };
    where.end_utc = { [Op.gt]: start };
  }

  // ── Normalizar parámetros de asignación ─────────────────────────
  const rawIds = Array.isArray(user_ids)
    ? user_ids
    : typeof user_ids === 'string'
    ? user_ids.split(',')
    : [];

  // Acepta "7", 7; filtra vacíos; conserva número si aplica
  const ids = rawIds
    .map((v) => String(v).trim())
    .filter((v) => v !== '')
    .map((v) => (Number.isFinite(Number(v)) ? Number(v) : v));

  const incUnassigned =
    include_unassigned === 1 ||
    include_unassigned === '1' ||
    include_unassigned === true ||
    include_unassigned === 'true';

  // Log mínimo de auditoría (opcional)
  console.log(
    '[appointments:list] calendar_id=%s, ids=%j, incUnassigned=%s, range=%s..%s',
    calendar_id,
    ids,
    incUnassigned,
    start,
    end
  );

  // ── Reglas de filtrado por assigned_user_id ─────────────────────
  if (ids.length && incUnassigned) {
    // (usuarios seleccionados) ∪ (sin asignar)
    where[Op.or] = [
      { assigned_user_id: { [Op.in]: ids } },
      { assigned_user_id: { [Op.is]: null } },
    ];
  } else if (ids.length && !incUnassigned) {
    // solo usuarios seleccionados
    where.assigned_user_id = { [Op.in]: ids };
  } else if (!ids.length && incUnassigned) {
    // solo sin asignar
    where.assigned_user_id = { [Op.is]: null };
  } else {
    // (!ids.length && !incUnassigned) => devolver NADA (forzamos conjunto vacío)
    where.assigned_user_id = { [Op.in]: [] };
  }

  const rows = await Appointment.findAll({
    where,
    order: [['start_utc', 'ASC']],
    attributes: [
      'id',
      'title',
      'status',
      'assigned_user_id',
      'contact_id',
      'start_utc',
      'end_utc',
      'booked_tz',
      'location_text',
      'meeting_url',
      'description',
      'created_at',
    ],
    include: [
      {
        model: Calendar,
        as: 'calendar',
        attributes: ['id', 'name', 'color_hex', 'time_zone'],
        required: false,
      },
      {
        model: AppointmentInvitee,
        as: 'invitees',
        attributes: ['id', 'name', 'email', 'phone', 'response_status'],
        required: false,
      },
    ],
  });

  // ── Formato FullCalendar + props extra ──────────────────────────
  return rows.map((r) => {
    const invitees =
      r.invitees?.map((i) => ({
        id: i.id,
        name: i.name,
        email: i.email,
        phone: i.phone,
        response_status: i.response_status,
      })) || [];

    const contact = r.contact_id
      ? invitees.find((i) => i.id === Number(r.contact_id)) || null
      : null;

    return {
      id: r.id,
      title: r.title,
      start: r.start_utc, // Si prefieres ISO: r.start_utc.toISOString()
      end: r.end_utc,
      created_at: r.created_at,
      extendedProps: {
        status: r.status,
        assigned_user_id: r.assigned_user_id,
        contact_id: r.contact_id,
        contact, // invitado que quedó como contacto principal
        booked_tz: r.booked_tz,
        location_text: r.location_text,
        meeting_url: r.meeting_url,
        description: r.description || null,
        calendar: r.calendar
          ? {
              id: r.calendar.id,
              name: r.calendar.name,
              color_hex: r.calendar.color_hex,
              time_zone: r.calendar.time_zone,
            }
          : null,
        invitees,
      },
    };
  });
}

/* ╔═══════════════════════════════════════════════════════════════════════╗
   ║ 3. CREATE                                                            ║
   ╚═══════════════════════════════════════════════════════════════════════╝ */
async function createAppointment(payload, currentUserId, opts = {}) {
  const startUtc = new Date(payload.start);
  const endUtc = new Date(payload.end);
  if (isNaN(startUtc) || isNaN(endUtc) || endUtc <= startUtc) {
    throw new AppError('Rango de fechas inválido.', 400);
  }
  const assigned = payload.assigned_user_id ?? currentUserId ?? null;
  const creator = payload.created_by_user_id ?? currentUserId ?? null;
  const invitees = Array.isArray(payload.invitees) ? payload.invitees : [];

  await assertNoOverlap({
    calendar_id: payload.calendar_id,
    start_utc: startUtc,
    end_utc: endUtc,
  });

  const appt = await db.transaction(async (t) => {
    const appt = await Appointment.create(
      {
        calendar_id: payload.calendar_id,
        title: payload.title,
        description: payload.description ?? null,
        status: payload.status ?? 'Agendado',
        assigned_user_id: assigned,
        contact_id: payload.contact_id ?? null,
        start_utc: startUtc,
        end_utc: endUtc,
        booked_tz: payload.booked_tz || 'America/Guayaquil',
        location_text: payload.location_text ?? null,
        meeting_url: payload.meeting_url ?? null,
        created_by_user_id: creator,
      },
      { transaction: t }
    );

    let firstInviteeId = null;
    for (const [idx, inv] of invitees.entries()) {
      const row = await AppointmentInvitee.create(
        {
          appointment_id: appt.id,
          name: inv.name || null,
          email: inv.email || null,
          phone: inv.phone || null,
          response_status: 'needsAction',
        },
        { transaction: t }
      );
      if (idx === 0) firstInviteeId = row.id;
    }
    if (!appt.contact_id && firstInviteeId) {
      await appt.update({ contact_id: firstInviteeId }, { transaction: t });
    }
    return appt;
  });

  // 🔌 push → Google
  if (payload.create_meet) {
    try {
      const res = await pushUpsertEvent({
        appointmentId: appt.id,
        createMeet: true,
      });
      if (res?.meetingUrl) {
        await appt.update({ meeting_url: res.meetingUrl }, { silent: true });
      }
    } catch (e) {
      await appt.update(
        { last_sync_error: e.message || String(e) },
        { silent: true }
      );
      console.warn('Google push upsert (create_meet) failed:', e?.message || e);
      // No lanzamos error: la cita ya se creó; simplemente no habrá link
    }
  } else {
    queueMicrotask(() => syncOutUpsert(appt, opts));
  }
  return appt;
}

/* ╔═══════════════════════════════════════════════════════════════════════╗
   ║ 4. UPDATE                                                             ║
   ╚═══════════════════════════════════════════════════════════════════════╝ */
async function updateAppointment(id, payload, opts = {}) {
  const appt = await Appointment.findByPk(id);
  if (!appt) throw new AppError('Cita no encontrada.', 404);

  const up = {};
  [
    'title',
    'description',
    'status',
    'assigned_user_id',
    'contact_id',
    'location_text',
    'meeting_url',
    'booked_tz',
    'created_by_user_id',
  ].forEach((f) => {
    if (payload[f] !== undefined) up[f] = payload[f];
  });

  let startUtc = appt.start_utc;
  let endUtc = appt.end_utc;
  if (payload.start) startUtc = new Date(payload.start);
  if (payload.end) endUtc = new Date(payload.end);

  if (payload.start || payload.end) {
    if (isNaN(startUtc) || isNaN(endUtc) || endUtc <= startUtc) {
      throw new AppError('Rango de fechas inválido.', 400);
    }
    up.start_utc = startUtc;
    up.end_utc = endUtc;
  }

  await assertNoOverlap({
    calendar_id: appt.calendar_id,
    start_utc: up.start_utc ?? startUtc,
    end_utc: up.end_utc ?? endUtc,
    ignoreId: appt.id,
  });

  const updated = await db.transaction(async (t) => {
    await appt.update(up, { transaction: t });

    if (Array.isArray(payload.invitees)) {
      const norm = (s) => (s ?? '').toString().trim();
      const normEmail = (s) => norm(s).toLowerCase();
      const normPhone = (s) => norm(s).replace(/\D+/g, '');

      const current = await AppointmentInvitee.findAll({
        where: { appointment_id: appt.id },
        transaction: t,
      });
      const byId = new Map(current.map((i) => [i.id, i]));
      const byEmail = new Map();
      const byPhone = new Map();
      for (const i of current) {
        if (i.email) byEmail.set(i.email.toLowerCase(), i);
        if (i.phone) byPhone.set(i.phone.replace(/\D+/g, ''), i);
      }

      const keptIds = new Set();
      for (const inv of payload.invitees) {
        const data = {
          name: norm(inv.name) || null,
          email: normEmail(inv.email) || null,
          phone: normPhone(inv.phone) || null,
        };
        const rs = inv.response_status;
        const validRS = ['needsAction', 'accepted', 'declined', 'tentative'];
        if (rs && validRS.includes(rs)) data.response_status = rs;

        let row = null;
        if (inv.id && byId.has(Number(inv.id))) row = byId.get(Number(inv.id));
        else if (data.email && byEmail.has(data.email))
          row = byEmail.get(data.email);
        else if (data.phone && byPhone.has(data.phone))
          row = byPhone.get(data.phone);

        if (row) {
          if (!('response_status' in data))
            data.response_status = row.response_status;
          await row.update(data, { transaction: t });
          keptIds.add(row.id);
        } else {
          const created = await AppointmentInvitee.create(
            {
              appointment_id: appt.id,
              response_status: 'needsAction',
              ...data,
            },
            { transaction: t }
          );
          keptIds.add(created.id);
        }
      }

      const toDelete = current.filter((i) => !keptIds.has(i.id));
      if (toDelete.length) {
        await AppointmentInvitee.destroy({
          where: { id: toDelete.map((i) => i.id) },
          transaction: t,
        });
      }

      let nextContactId = up.contact_id ?? appt.contact_id ?? null;
      if (nextContactId && !keptIds.has(Number(nextContactId))) {
        nextContactId = keptIds.size ? [...keptIds][0] : null;
      }
      if (up.contact_id !== undefined || nextContactId !== appt.contact_id) {
        await appt.update({ contact_id: nextContactId }, { transaction: t });
      }
    }

    await appt.reload({
      include: [
        {
          model: AppointmentInvitee,
          as: 'invitees',
          attributes: ['id', 'name', 'email', 'phone', 'response_status'],
        },
      ],
      transaction: t,
    });
    return appt;
  });

  // 🔌 push → Google (upsert o cancel según status actual)
  if ((updated.status || up.status) === 'Cancelado') {
    queueMicrotask(() => syncOutCancel(updated, opts));
  } else {
    queueMicrotask(() => syncOutUpsert(updated, opts));
  }
  return updated;
}

/* ╔═══════════════════════════════════════════════════════════════════════╗
   ║ 5. CANCEL                                                             ║
   ╚═══════════════════════════════════════════════════════════════════════╝ */
async function cancelAppointment(id, opts = {}) {
  const appt = await Appointment.findByPk(id);
  if (!appt) throw new AppError('Cita no encontrada.', 404);
  await appt.update({ status: 'Cancelado' });

  // push -> Google como cancelado
  queueMicrotask(() => syncOutCancel(appt, opts));
  return appt;
}

/* ╔═══════════════════════════════════════════════════════════════════════╗
   ║ EXPORTS                                                               ║
   ╚═══════════════════════════════════════════════════════════════════════╝ */
module.exports = {
  listAppointments,
  createAppointment,
  updateAppointment,
  cancelAppointment,
};
