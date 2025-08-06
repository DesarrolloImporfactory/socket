// services/appointments.service.js
const { Op } = require('sequelize');
const Appointment = require('../models/appointment.model');
const AppointmentInvitee = require('../models/appointment_invitee.model');
const AppError = require('../utils/appError');
const { db } = require('../database/config');

/**
 * Verifica solapes de citas a nivel de calendario.
 * Si quisieras validar por usuario, añade assigned_user_id al where (comentado abajo).
 */
async function assertNoOverlap({
  calendar_id,
  start_utc,
  end_utc,
  ignoreId = null /*, assigned_user_id*/,
}) {
  const where = {
    calendar_id,
    status: { [Op.in]: ['scheduled', 'confirmed', 'blocked'] },
    start_utc: { [Op.lt]: end_utc },
    end_utc: { [Op.gt]: start_utc },
  };
  if (ignoreId) where.id = { [Op.ne]: ignoreId };

  // 👉 Para solape por usuario (si deseas):
  // if (assigned_user_id != null) where.assigned_user_id = assigned_user_id;

  const conflict = await Appointment.findOne({ where });
  if (conflict)
    throw new AppError('Conflicto de horario en el calendario.', 409);
}

async function listAppointments({ calendar_id, start, end, user_ids }) {
  const where = { calendar_id };
  if (start && end) {
    // Intersección con el rango [start, end]
    where.start_utc = { [Op.lt]: end };
    where.end_utc = { [Op.gt]: start };
  }
  if (user_ids && user_ids.length) {
    where.assigned_user_id = { [Op.in]: user_ids };
  }

  const rows = await Appointment.findAll({
    where,
    order: [['start_utc', 'ASC']],
  });

  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    start: r.start_utc, // ISO UTC
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

async function createAppointment(payload, currentUserId) {
  const startUtc = new Date(payload.start);
  const endUtc = new Date(payload.end);

  if (
    isNaN(startUtc.getTime()) ||
    isNaN(endUtc.getTime()) ||
    endUtc <= startUtc
  ) {
    throw new AppError('Rango de fechas inválido.', 400);
  }

  const assigned = payload.assigned_user_id ?? currentUserId ?? null;
  const invitees = Array.isArray(payload.invitees) ? payload.invitees : [];

  // Valida solape (a nivel calendario por defecto)
  await assertNoOverlap({
    calendar_id: payload.calendar_id,
    start_utc: startUtc,
    end_utc: endUtc,
    // assigned_user_id: assigned, // (actívalo si quieres solape por usuario)
  });

  return await db.transaction(async (t) => {
    const appt = await Appointment.create(
      {
        calendar_id: payload.calendar_id,
        title: payload.title,
        description: payload.description ?? null,
        status: payload.status ?? 'scheduled',
        assigned_user_id: assigned,
        contact_id: payload.contact_id ?? null,
        start_utc: startUtc,
        end_utc: endUtc,
        booked_tz: payload.booked_tz || 'America/Guayaquil',
        location_text: payload.location_text ?? null,
        meeting_url: payload.meeting_url ?? null,
        created_by_user_id: currentUserId ?? null,
      },
      { transaction: t }
    );

    // Invitados (opcional)
    if (invitees.length) {
      const rows = invitees
        .filter((i) => i?.email || i?.phone)
        .map((i) => ({
          appointment_id: appt.id,
          name: i.name || null,
          email: i.email || null,
          phone: i.phone || null,
          response_status: 'needsAction',
        }));
      if (rows.length) {
        await AppointmentInvitee.bulkCreate(rows, { transaction: t });
      }
    }

    return appt;
  });
}

async function updateAppointment(id, payload) {
  const appt = await Appointment.findByPk(id);
  if (!appt) throw new AppError('Cita no encontrada.', 404);

  const up = {};
  const fields = [
    'title',
    'description',
    'status',
    'assigned_user_id',
    'contact_id',
    'location_text',
    'meeting_url',
  ];
  fields.forEach((f) => {
    if (payload[f] !== undefined) up[f] = payload[f];
  });

  let startUtc = appt.start_utc;
  let endUtc = appt.end_utc;
  const tz = payload.booked_tz || appt.booked_tz || 'America/Guayaquil'; // guardado como referencia

  if (payload.start) startUtc = new Date(payload.start);
  if (payload.end) endUtc = new Date(payload.end);

  if (payload.start || payload.end || payload.booked_tz) {
    if (
      isNaN(startUtc.getTime()) ||
      isNaN(endUtc.getTime()) ||
      endUtc <= startUtc
    ) {
      throw new AppError('Rango de fechas inválido.', 400);
    }
    up.start_utc = startUtc;
    up.end_utc = endUtc;
    up.booked_tz = tz;
  }

  // ❌ Sin validación de membership (ya no usamos calendar_members)
  // Si quieres, aquí puedes validar que assigned_user_id exista en tu sistema real.

  return await db.transaction(async (t) => {
    await assertNoOverlap({
      calendar_id: appt.calendar_id,
      start_utc: up.start_utc ?? startUtc,
      end_utc: up.end_utc ?? endUtc,
      ignoreId: appt.id,
      // assigned_user_id: up.assigned_user_id ?? appt.assigned_user_id, // (para solape por usuario)
    });

    await appt.update(up, { transaction: t });

    // (Opcional) actualizar invitados aquí si lo necesitas en el futuro

    return appt;
  });
}

async function cancelAppointment(id) {
  const appt = await Appointment.findByPk(id);
  if (!appt) throw new AppError('Cita no encontrada.', 404);
  await appt.update({ status: 'cancelled' });
  return appt;
}

module.exports = {
  listAppointments,
  createAppointment,
  updateAppointment,
  cancelAppointment,
};
