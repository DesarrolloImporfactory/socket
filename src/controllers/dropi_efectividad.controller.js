/**
 * dropi_efectividad.controller.js
 * Bloque «Efectividad por ciudad» del dashboard de conexión v2.
 *   POST /dropi_integrations/dashboard/efectividad     { id_configuracion, from, until }
 *   POST /dropi_integrations/dashboard/efectividad-ia  { id_configuracion, from, until }
 * Lógica en services/dropi_efectividad.service.js.
 */
const catchAsync = require('../utils/catchAsync');
const AppError = require('../utils/appError');
const {
  calcularEfectividad,
  analizarConIA,
} = require('../services/dropi_efectividad.service');

const esFecha = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));

function leerParametros(req, next) {
  const id_configuracion = Number(req.body?.id_configuracion) || null;
  const from = String(req.body?.from || '').trim();
  const until = String(req.body?.until || '').trim();
  if (!id_configuracion) {
    next(new AppError('id_configuracion es requerido', 400));
    return null;
  }
  if (!esFecha(from) || !esFecha(until)) {
    next(new AppError('from y until son requeridos (YYYY-MM-DD)', 400));
    return null;
  }
  return { id_configuracion, from, until };
}

exports.getEfectividad = catchAsync(async (req, res, next) => {
  const p = leerParametros(req, next);
  if (!p) return undefined;
  const data = await calcularEfectividad(p);
  return res.json({ isSuccess: true, data });
});

exports.analizarEfectividadIA = catchAsync(async (req, res, next) => {
  const p = leerParametros(req, next);
  if (!p) return undefined;
  try {
    const data = await analizarConIA(p);
    return res.json({ isSuccess: true, data });
  } catch (err) {
    // Errores del negocio (sin key, sin saldo, sin muestra) llegan con .codigo.
    if (err?.codigo) {
      const e = new AppError(err.message, 400);
      e.code = err.codigo;
      return next(e);
    }
    throw err;
  }
});
