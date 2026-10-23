// controllers/onboarding.controller.js — invitación a agendar la implementación.
// La cuenta sale SIEMPRE de la sesión (req.sessionUser.id_usuario), nunca del
// body: un subusuario no puede consultar ni responder por otra cuenta.
const catchAsync = require('../utils/catchAsync');
const AppError = require('../utils/appError');
const svc = require('../services/onboarding.service');

/* GET /api/v1/onboarding/implementacion → { mostrar, motivo, calendly_url, dueno, conexiones } */
exports.implementacion = catchAsync(async (req, res, next) => {
  const id_usuario = Number(req.sessionUser?.id_usuario);
  if (!id_usuario) return next(new AppError('Sesión sin cuenta', 401));
  const data = await svc.estadoImplementacion(id_usuario);
  res.json({ status: 'success', data });
});

/* POST /api/v1/onboarding/implementacion/mostrado — el modal se abrió (métrica). */
exports.mostrado = catchAsync(async (req, res, next) => {
  const id_usuario = Number(req.sessionUser?.id_usuario);
  if (!id_usuario) return next(new AppError('Sesión sin cuenta', 401));
  await svc.marcarMostrado(id_usuario);
  res.json({ status: 'success' });
});

/* POST /api/v1/onboarding/implementacion/respuesta { accion: agendo | no_por_ahora | no_mostrar } */
exports.respuesta = catchAsync(async (req, res, next) => {
  const id_usuario = Number(req.sessionUser?.id_usuario);
  if (!id_usuario) return next(new AppError('Sesión sin cuenta', 401));
  const accion = String(req.body?.accion || '').trim();
  if (!['agendo', 'no_por_ahora', 'no_mostrar'].includes(accion)) {
    return next(new AppError('accion debe ser agendo, no_por_ahora o no_mostrar', 400));
  }
  const data = await svc.responderImplementacion({
    id_usuario,
    accion,
    id_sub_usuario: req.sessionUser?.id_sub_usuario || null,
  });
  res.json({ status: 'success', data });
});
