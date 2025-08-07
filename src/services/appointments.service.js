/* -----------------------------------------------------------------------
   Servicio de Citas (Appointments)
   - Valida solapes
   - CRUD de citas
   - Maneja invitados y actualiza contact_id ↔ appointment_invitees
   ----------------------------------------------------------------------- */
const { Op } = require('sequelize');
const Appointment = require('../models/appointment.model');
const AppointmentInvitee = require('../models/appointment_invitee.model');
const AppError = require('../utils/appError');
const { db } = require('../database/config');

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

/* ╔═══════════════════════════════════════════════════════════════════════╗
   ║ 2. LIST                                                             ║
   ╚═══════════════════════════════════════════════════════════════════════╝ */
async function listAppointments({ calendar_id, start, end, user_ids }) {
  const where = { calendar_id };
  if (start && end) {
    // intersección con [start, end]
    where.start_utc = { [Op.lt]: end };
    where.end_utc = { [Op.gt]: start };
  }
  if (user_ids?.length) {
    where.assigned_user_id = { [Op.in]: user_ids };
  }

  const rows = await Appointment.findAll({
    where,
    order: [['start_utc', 'ASC']],
  });

  /* Se devuelven en formato FullCalendar */
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    start: r.start_utc,
    end: r.end_utc,
    extendedProps: {
      status: r.status,
      assigned_user_id: r.assigned_user_id,
      contact_id: r.contact_id,
      booked_tz: r.booked_tz,
      location_text: r.location_text,
      meeting_url: r.meeting_url,
      description: r.description,
    },
  }));
}

/* ╔═══════════════════════════════════════════════════════════════════════╗
   ║ 3. CREATE                                                            ║
   ╚═══════════════════════════════════════════════════════════════════════╝ */
async function createAppointment(payload, currentUserId) {
  const startUtc = new Date(payload.start);
  const endUtc = new Date(payload.end);

  /* Validación básica del rango horario */
  if (isNaN(startUtc) || isNaN(endUtc) || endUtc <= startUtc) {
    throw new AppError('Rango de fechas inválido.', 400);
  }

  /* Quién atenderá y quién está creando */
  const assigned = payload.assigned_user_id ?? currentUserId ?? null;
  const creator = payload.created_by_user_id ?? currentUserId ?? null;

  /* Invitados recibidos desde el front (array de {name,email,phone}) */
  const invitees = Array.isArray(payload.invitees) ? payload.invitees : [];

  /* Verifica que no se pise otra cita */
  await assertNoOverlap({
    calendar_id: payload.calendar_id,
    start_utc: startUtc,
    end_utc: endUtc,
    // assigned_user_id : assigned, // habilita si validas por usuario
  });

  /* Transacción para crear todo junto */
  return db.transaction(async (t) => {
    /* 3.1 Cita principal -------------------------------------------------- */
    const appt = await Appointment.create(
      {
        calendar_id: payload.calendar_id,
        title: payload.title,
        description: payload.description ?? null,
        status: payload.status ?? 'Agendado',
        assigned_user_id: assigned,
        contact_id: payload.contact_id ?? null, // se actualizará abajo
        start_utc: startUtc,
        end_utc: endUtc,
        booked_tz: payload.booked_tz || 'America/Guayaquil',
        location_text: payload.location_text ?? null,
        meeting_url: payload.meeting_url ?? null,
        created_by_user_id: creator,
      },
      { transaction: t }
    );

    /* 3.2 Invitados ------------------------------------------------------- */
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

      if (idx === 0) firstInviteeId = row.id; // primer invitado = contacto ppal
    }

    /* 3.3 Si la cita no traía contact_id y creamos invitados,
            actualizamos con el primero                           */
    if (!appt.contact_id && firstInviteeId) {
      await appt.update({ contact_id: firstInviteeId }, { transaction: t });
    }

    return appt; // ya consistente
  });
}

/* ╔═══════════════════════════════════════════════════════════════════════╗
   ║ 4. UPDATE                                                             ║
   ╚═══════════════════════════════════════════════════════════════════════╝ */
async function updateAppointment(id, payload) {
  const appt = await Appointment.findByPk(id);
  if (!appt) throw new AppError('Cita no encontrada.', 404);

  /* --- 4.1 Campos permitidos a editar ---------------------------------- */
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

  /* --- 4.2 Manejo de start/end ----------------------------------------- */
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

  /* --- 4.3 Validación de solape ---------------------------------------- */
  await assertNoOverlap({
    calendar_id: appt.calendar_id,
    start_utc: up.start_utc ?? startUtc,
    end_utc: up.end_utc ?? endUtc,
    ignoreId: appt.id,
    // assigned_user_id: up.assigned_user_id ?? appt.assigned_user_id,
  });

  /* --- 4.4 Aplicamos cambios (invitados opcionales) -------------------- */
  return db.transaction(async (t) => {
    await appt.update(up, { transaction: t });

    /* (Opcional) si el front manda invitees en edición,
       aquí podrías sincronzar la tabla AppointmentInvitee */

    return appt;
  });
}

/* ╔═══════════════════════════════════════════════════════════════════════╗
   ║ 5. CANCEL                                                             ║
   ╚═══════════════════════════════════════════════════════════════════════╝ */
async function cancelAppointment(id) {
  const appt = await Appointment.findByPk(id);
  if (!appt) throw new AppError('Cita no encontrada.', 404);
  await appt.update({ status: 'cancelled' });
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
