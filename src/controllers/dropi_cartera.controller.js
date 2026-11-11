/**
 * dropi_cartera.controller.js
 * Bloque «Cobros de Dropi para reclamar» del dashboard de conexión v2.
 *   POST /dropi_integrations/dashboard/cartera          { id_configuracion }
 *   POST /dropi_integrations/dashboard/cartera/marcar   { id_configuracion, dropi_order_id, estado }
 * Lógica en services/dropi_cartera.service.js.
 */
const catchAsync = require('../utils/catchAsync');
const AppError = require('../utils/appError');
const {
  resumenCartera,
  marcarReclamo,
} = require('../services/dropi_cartera.service');

exports.getCartera = catchAsync(async (req, res, next) => {
  const id_configuracion = Number(req.body?.id_configuracion) || null;
  if (!id_configuracion)
    return next(new AppError('id_configuracion es requerido', 400));
  const data = await resumenCartera({ id_configuracion });
  return res.json({ isSuccess: true, data });
});

exports.marcarReclamo = catchAsync(async (req, res, next) => {
  const id_configuracion = Number(req.body?.id_configuracion) || null;
  const dropi_order_id = Number(req.body?.dropi_order_id) || null;
  const estado = String(req.body?.estado || '').trim();
  if (!id_configuracion || !dropi_order_id)
    return next(new AppError('id_configuracion y dropi_order_id son requeridos', 400));
  try {
    const data = await marcarReclamo({ id_configuracion, dropi_order_id, estado });
    if (!data.actualizada) return next(new AppError('No hay un cobro para reclamar en esa orden', 404));
    return res.json({ isSuccess: true, data });
  } catch (err) {
    if (err?.codigo) return next(new AppError(err.message, 400));
    throw err;
  }
});
