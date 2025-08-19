const catchAsync = require('../utils/catchAsync');
const AppError = require('../utils/appError');
const svc = require('../services/appointments.service');

exports.list = catchAsync(async (req, res) => {
  const { calendar_id, start, end, user_ids, include_unassigned } = req.query;
  if (!calendar_id) throw new AppError('calendar_id es obligatorio.', 400);

  const events = await svc.listAppointments({
    calendar_id: Number(calendar_id),
    start: start ? new Date(start) : undefined,
    end: end ? new Date(end) : undefined,
    user_ids,
    include_unassigned,
  });

  res.status(200).json({ status: 'success', events });
});

exports.create = catchAsync(async (req, res) => {
  const currentUserId = req.user?.id_users ?? req.user?.id_usuario ?? null;
  const appt = await svc.createAppointment(req.body, currentUserId);

  // ECHO de lo que mandó el cliente (si vino). Si no vino, caemos al valor persistido.
  const startEcho = req.body?.start ?? appt.start_utc;
  const endEcho = req.body?.end ?? appt.end_utc;

  res.status(201).json({
    status: 'success',
    appointment: appt,
    start: startEcho,
    end: endEcho,
    meeting_url: appt.meeting_url ?? null,
  });
});

exports.update = catchAsync(async (req, res) => {
  const appt = await svc.updateAppointment(req.params.id, req.body);

  const startEcho = req.body?.start ?? appt.start_utc;
  const endEcho = req.body?.end ?? appt.end_utc;

  res.status(200).json({
    status: 'success',
    appointment: appt,
    start: startEcho,
    end: endEcho,
    meeting_url: appt.meeting_url ?? null,
  });
});

exports.cancel = catchAsync(async (req, res) => {
  const appt = await svc.cancelAppointment(req.params.id);
  res.status(200).json({ status: 'success', appointment: appt });
});
