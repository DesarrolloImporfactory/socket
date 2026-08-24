const catchAsync = require('../utils/catchAsync');
const AppError = require('../utils/appError');
const svc = require('../services/mentorias_erp.service');

/**
 * GET /api/v1/mentorias_erp/ocupacion?desde=<iso>&hasta=<iso>
 *
 * Lo que el ERP necesita para tachar horarios de su grilla.
 */
exports.ocupacion = catchAsync(async (req, res) => {
  const { desde, hasta } = req.query;
  if (!desde || !hasta) {
    throw new AppError('`desde` y `hasta` son obligatorios.', 400);
  }

  const data = await svc.ocupacion({ desde, hasta });
  res.status(200).json({ status: 'success', ...data });
});

/**
 * POST /api/v1/mentorias_erp/citas
 * Body: { inicio, fin, titulo, descripcion?, alumno: { nombre, email, telefono } }
 *
 * `inicio` y `fin` en ISO con offset ('2026-08-25T09:00:00-05:00'). Mandarlos
 * con offset y no como hora suelta es lo que evita que el evento aterrice
 * corrido en Google: la zona viaja con el dato, no se adivina después.
 */
exports.crear = catchAsync(async (req, res) => {
  const { inicio, fin, titulo, descripcion, alumno } = req.body || {};

  const data = await svc.crear({ inicio, fin, titulo, descripcion, alumno });
  res.status(201).json({ status: 'success', ...data });
});

/**
 * POST /api/v1/mentorias_erp/citas/:id/cancelar
 */
exports.cancelar = catchAsync(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    throw new AppError('Id de cita inválido.', 400);
  }

  const data = await svc.cancelar({ appointmentId: id });
  res.status(200).json({ status: 'success', ...data });
});

/**
 * GET /api/v1/mentorias_erp/estado
 *
 * Qué calendario y qué mentores tiene configurados este despliegue. Existe
 * para diagnosticar: cuando una mentoría no aparece en Google, la primera
 * pregunta es siempre si el `.env` del servidor dice lo que uno cree.
 */
exports.estado = catchAsync(async (req, res) => {
  const { calendarId, mentores, creadoPor, zona, bloqueaTodo } = svc.config();
  res.status(200).json({
    status: 'success',
    calendar_id: calendarId,
    mentores,
    created_by: creadoPor,
    time_zone: zona,
    bloquea_calendario_completo: bloqueaTodo,
  });
});
