/**
 * dropi_rentabilidad.controller.js
 * Bloque «¿Cuánto ganaste de verdad?» del dashboard de conexión v2.
 *   POST /dropi_integrations/dashboard/rentabilidad  { id_configuracion, from, until }
 * Lógica en services/dropi_rentabilidad.service.js.
 */
const catchAsync = require('../utils/catchAsync');
const AppError = require('../utils/appError');
const {
  calcularRentabilidad,
} = require('../services/dropi_rentabilidad.service');

const esFecha = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));

exports.getRentabilidad = catchAsync(async (req, res, next) => {
  const id_configuracion = Number(req.body?.id_configuracion) || null;
  const from = String(req.body?.from || '').trim();
  const until = String(req.body?.until || '').trim();
  if (!id_configuracion)
    return next(new AppError('id_configuracion es requerido', 400));
  if (!esFecha(from) || !esFecha(until) || from > until)
    return next(new AppError('from y until son requeridos (YYYY-MM-DD)', 400));
  const dias = (new Date(until) - new Date(from)) / 86400000;
  if (dias > 180) return next(new AppError('Rango máximo 180 días', 400));
  const data = await calcularRentabilidad({ id_configuracion, from, until });
  return res.json({ isSuccess: true, data });
});
