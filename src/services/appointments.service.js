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

// Escribe UTC real como 'YYYY-MM-DD HH:MM:SS', mismo criterio que el PULL (toMysqlDateTime).
// Evita que MySQL (time_zone=SYSTEM) reinterprete el Date y reste horas al guardar.
function toUtcMysql(v) {
  const d = v instanceof Date ? v : new Date(v);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

// Normaliza cualquier valor de fecha al MISMO formato en que está guardada la
// columna: 'YYYY-MM-DD HH:MM:SS' en UTC real.
// Es obligatorio para comparar en el WHERE: si se le pasa un Date a Sequelize,
// mysql2 lo serializa usando el timezone de la conexión ('-05:00'), con lo que
// la comparación quedaría corrida 5 horas respecto de lo almacenado.
function toUtcMysqlParam(v) {
  if (v == null) return null;
  if (v instanceof Date) return toUtcMysql(v);
  const s = String(v).trim();
  // ya viene como la columna ('2026-07-29 19:00:00' = UTC) → no tocar
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}$/.test(s))
    return s.replace('T', ' ');
  // ISO con zona ('2026-07-29T14:00:00-05:00' / '...Z') → pasar a UTC
  return toUtcMysql(s);
}

// Valor de la columna (UTC) → objeto Date correcto.
function utcColumnToDate(v) {
  if (!v) return null;
  if (v instanceof Date) return v;
  const d = new Date(utcColumnToIso(v));
  return Number.isNaN(d.getTime()) ? null : d;
}
/* ╔═══════════════════════════════════════════════════════════════════════╗
   ║ 1. VERIFY OVERLAPS                                                   ║
   ╚═══════════════════════════════════════════════════════════════════════╝ */
async function assertNoOverlap({
  calendar_id,
  start_utc,
  end_utc,
  ignoreId = null, // ← al actualizar excluimos la propia cita
  assigned_user_id = null, // ← encargado de la cita que se está guardando
  id_profesional = null, // ← quién la atiende, si la sede tiene profesionales
}) {
  // Comparar SIEMPRE con strings UTC, igual que como se escribe la columna.
  const startStr = toUtcMysqlParam(start_utc);
  const endStr = toUtcMysqlParam(end_utc);
  if (!startStr || !endStr) throw new AppError('Rango de fechas inválido.', 400);

  const where = {
    calendar_id,
    status: { [Op.in]: ['Agendado', 'Confirmado', 'Bloqueado'] },
    start_utc: { [Op.lt]: endStr }, // empieza antes de que termine la nueva
    end_utc: { [Op.gt]: startStr }, // termina después de que empieza la nueva
  };
  if (ignoreId) where.id = { [Op.ne]: ignoreId };

  /* ── Solape POR PROFESIONAL ──────────────────────────────────────
     Cuando la sede tiene profesionales cargados, la capacidad la define quién
     atiende y no quién gestiona la cita: tres esteticistas son tres citas
     simultáneas. Un 'Bloqueado' sin profesional (feriado, cierre) cierra el
     local entero y por eso también choca. */
  if (id_profesional != null) {
    where[Op.or] = [
      { id_profesional: Number(id_profesional) },
      { id_profesional: { [Op.is]: null }, status: 'Bloqueado' },
    ];

    const conflictoProf = await Appointment.findOne({ where });
    if (conflictoProf) {
      throw new AppError(
        'Conflicto de horario: quien atiende ya tiene una cita en ese rango.',
        409,
      );
    }
    return;
  }

  // ── Solape POR ENCARGADO ────────────────────────────────────────
  // Varios asesores del mismo calendario pueden atender a la misma hora:
  // solo choca si el horario ya está ocupado por el MISMO encargado.
  const asesor =
    assigned_user_id === null || assigned_user_id === undefined
      ? null
      : Number(assigned_user_id);

  if (asesor === null) {
    // Cita sin encargado → solo choca con otras sin encargado.
    where.assigned_user_id = { [Op.is]: null };
  } else {
    where[Op.or] = [
      { assigned_user_id: asesor },
      // Un 'Bloqueado' sin encargado bloquea el calendario completo
      // (feriados, cierres), así que aplica a todos los asesores.
      { assigned_user_id: { [Op.is]: null }, status: 'Bloqueado' },
    ];
  }

  const conflict = await Appointment.findOne({ where });
  if (conflict) {
    throw new AppError(
      asesor === null
        ? 'Conflicto de horario: ya existe una cita sin encargado en ese rango.'
        : 'Conflicto de horario: el encargado ya tiene una cita en ese rango.',
      409,
    );
  }
}

/* ================= ENGANCHE: push out (evita bucles) ================= */
async function syncOutUpsert(appt, opts) {
  if (opts?.source === 'google') return;

  try {
    const res = await pushUpsertEvent({
      appointmentId: appt.id,
      createMeet: !!opts?.createMeet,
      // ⬇⬇ IMPORTANTE: propagar overrides del update/crear
      start: opts?.start, // puede ser ISO con offset o Date
      end: opts?.end, // idem
      timeZone: opts?.timeZone, // p.ej. 'America/Guayaquil'
    });

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

    // si Google devolvió link, guárdalo
    if (res?.meetingUrl) {
      try {
        await appt.update({ meeting_url: res.meetingUrl }, { silent: true });
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

// Toma lo que haya en la columna (Date o 'YYYY-MM-DD HH:MM:SS' que ES UTC)
// y devuelve ISO con 'Z' para que el front lo convierta a la zona correcta.
function utcColumnToIso(v) {
  if (!v) return null;
  if (v instanceof Date) return v.toISOString();
  // string tipo '2026-07-01 22:30:00' (UTC) → '2026-07-01T22:30:00Z'
  const s = String(v).replace(' ', 'T');
  return /[zZ]|[+-]\d{2}:\d{2}$/.test(s) ? s : s + 'Z';
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
    end,
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
      'id_profesional',
      'id_establecimiento',
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

  /* Quién atiende y en qué sede. El id solo no sirve de nada en pantalla: el
     dueño necesita ver "atiende Karla, sede Norte" para saber a quién le está
     ocupando la hora, que es distinto del sub-usuario del sistema que quedó
     asignado a la tarjeta. */
  const idsProf = [...new Set(rows.map((r) => r.id_profesional).filter(Boolean))];
  const idsSede = [
    ...new Set(rows.map((r) => r.id_establecimiento).filter(Boolean)),
  ];

  const profesionales = idsProf.length
    ? await db.query(
        `SELECT id, nombre, id_establecimiento FROM profesionales_chat_center
          WHERE id IN (:ids)`,
        { replacements: { ids: idsProf }, type: db.QueryTypes.SELECT },
      )
    : [];

  const sedes = idsSede.length
    ? await db.query(
        `SELECT id, nombre, ciudad FROM establecimientos_chat_center
          WHERE id IN (:ids)`,
        { replacements: { ids: idsSede }, type: db.QueryTypes.SELECT },
      )
    : [];

  const profPorId = new Map(profesionales.map((p) => [Number(p.id), p]));
  const sedePorId = new Map(sedes.map((s) => [Number(s.id), s]));

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
      start: utcColumnToIso(r.start_utc),
      end: utcColumnToIso(r.end_utc),
      created_at: r.created_at,
      extendedProps: {
        status: r.status,
        assigned_user_id: r.assigned_user_id,
        id_profesional: r.id_profesional,
        profesional: profPorId.get(Number(r.id_profesional)) || null,
        id_establecimiento: r.id_establecimiento,
        sede: sedePorId.get(Number(r.id_establecimiento)) || null,
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
    assigned_user_id: assigned,
    id_profesional: payload.id_profesional ?? null,
  });

  const appt = await db.transaction(async (t) => {
    const appt = await Appointment.create(
      {
        calendar_id: payload.calendar_id,
        title: payload.title,
        description: payload.description ?? null,
        status: payload.status ?? 'Agendado',
        assigned_user_id: assigned,
        id_profesional: payload.id_profesional ?? null,
        contact_id: payload.contact_id ?? null,
        start_utc: toUtcMysql(startUtc),
        end_utc: toUtcMysql(endUtc),
        booked_tz: payload.booked_tz || 'America/Guayaquil',
        location_text: payload.location_text ?? null,
        meeting_url: payload.meeting_url ?? null,
        created_by_user_id: creator,
      },
      { transaction: t },
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
        { transaction: t },
      );
      if (idx === 0) firstInviteeId = row.id;
    }
    if (!appt.contact_id && firstInviteeId) {
      await appt.update({ contact_id: firstInviteeId }, { transaction: t });
    }
    return appt;
  });

  // 🔌 push → Google
  const tz = payload.booked_tz || 'UTC';
  if (payload.create_meet) {
    try {
      const res = await pushUpsertEvent({
        appointmentId: appt.id,
        createMeet: true,
        // ⬇⬇ Usa lo que envía el front (con offset)
        start: payload.start,
        end: payload.end,
        timeZone: tz,
      });
      if (res?.meetingUrl) {
        await appt.update({ meeting_url: res.meetingUrl }, { silent: true });
      }
    } catch (e) {
      await appt.update(
        { last_sync_error: e.message || String(e) },
        { silent: true },
      );
      console.warn('Google push upsert (create_meet) failed:', e?.message || e);
    }
  } else {
    // ⬇⬇ Pasa start/end/timeZone al push en background
    queueMicrotask(() =>
      syncOutUpsert(appt, {
        ...opts,
        start: payload.start,
        end: payload.end,
        timeZone: tz,
      }),
    );
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
    // Quién atiende: se puede reasignar desde el calendario cuando la agenda
    // real del local cambia (alguien falta, entra otra esteticista).
    'id_profesional',
    'id_establecimiento',
    'contact_id',
    'location_text',
    'meeting_url',
    'booked_tz',
    'created_by_user_id',
  ].forEach((f) => {
    if (payload[f] !== undefined) up[f] = payload[f];
  });

  // Vacío desde un <select> llega como "" y guardarlo rompería el FK.
  for (const f of ['id_profesional', 'id_establecimiento']) {
    if (up[f] === '' || up[f] === 0) up[f] = null;
    else if (up[f] != null) up[f] = Number(up[f]);
  }

  // La columna guarda strings UTC → convertir a Date para poder comparar
  // cuando el update trae solo uno de los dos extremos.
  let startUtc = utcColumnToDate(appt.start_utc);
  let endUtc = utcColumnToDate(appt.end_utc);
  if (payload.start) startUtc = new Date(payload.start);
  if (payload.end) endUtc = new Date(payload.end);

  if (payload.start || payload.end) {
    if (
      !startUtc ||
      !endUtc ||
      isNaN(startUtc) ||
      isNaN(endUtc) ||
      endUtc <= startUtc
    ) {
      throw new AppError('Rango de fechas inválido.', 400);
    }
    up.start_utc = toUtcMysql(startUtc);
    up.end_utc = toUtcMysql(endUtc);
  }

  // Encargado resultante tras el update (puede venir en el payload o no)
  const nextAssigned =
    up.assigned_user_id !== undefined
      ? up.assigned_user_id
      : appt.assigned_user_id;

  /* Si la cita la atiende alguien de la sede, el choque se mide contra ESA
     persona: dos esteticistas pueden atender a la misma hora, la misma no. */
  const nextProfesional =
    up.id_profesional !== undefined ? up.id_profesional : appt.id_profesional;

  await assertNoOverlap({
    calendar_id: appt.calendar_id,
    start_utc: up.start_utc ?? startUtc,
    end_utc: up.end_utc ?? endUtc,
    ignoreId: appt.id,
    assigned_user_id: nextAssigned,
    id_profesional: nextProfesional,
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
            { transaction: t },
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

  const wantsCreateMeet = payload.create_meet === true && !payload.meeting_url;
  const newStatus = up.status ?? updated.status;
  const tz = payload.booked_tz || updated.booked_tz || 'UTC';

  try {
    if (newStatus === 'Cancelado') {
      queueMicrotask(() => syncOutCancel(updated, opts));
    } else if (wantsCreateMeet) {
      // Sincrónico, pasando fechas/TZ
      const res = await pushUpsertEvent({
        appointmentId: updated.id,
        createMeet: true,
        start: payload.start, // puede venir con offset
        end: payload.end,
        timeZone: tz,
      });

      if (res?.meetingUrl) {
        await updated.update({ meeting_url: res.meetingUrl }, { silent: true });
      }
      if (res && (res.eventId || res.etag)) {
        await updated.update(
          {
            google_event_id: res.eventId ?? updated.google_event_id ?? null,
            google_etag: res.etag ?? updated.google_etag ?? null,
            last_synced_at: new Date(),
            last_sync_error: null,
          },
          { silent: true },
        );
      } else {
        await updated.update(
          { last_synced_at: new Date(), last_sync_error: null },
          { silent: true },
        );
      }
    } else {
      // Background, pero pasando fechas/TZ
      queueMicrotask(() =>
        syncOutUpsert(updated, {
          ...opts,
          start: payload.start, // si no vinieron, quedarán undefined
          end: payload.end, // y pushUpsertEvent cae a appt.start_utc/end_utc
          timeZone: tz,
        }),
      );
    }
  } catch (e) {
    try {
      await updated.update(
        { last_sync_error: e.message || String(e) },
        { silent: true },
      );
    } catch (_) {}
    console.warn(
      'Google push upsert (update/create_meet) failed:',
      e?.message || e,
    );
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
