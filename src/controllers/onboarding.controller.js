// controllers/onboarding.controller.js — invitación a agendar la implementación.
// La cuenta sale SIEMPRE de la sesión (req.sessionUser.id_usuario), nunca del
// body: un subusuario no puede consultar ni responder por otra cuenta.
const catchAsync = require('../utils/catchAsync');
const AppError = require('../utils/appError');
const svc = require('../services/onboarding.service');

/* GET /api/v1/onboarding/implementacion → { mostrar, motivo, agenda_url, reserva, dueno, conexiones } */
exports.implementacion = catchAsync(async (req, res, next) => {
  const id_usuario = Number(req.sessionUser?.id_usuario);
  if (!id_usuario) return next(new AppError('Sesión sin cuenta', 401));
  const data = await svc.estadoImplementacion(id_usuario);
  // El saludo lleva el nombre de la PERSONA (nombre_encargado del subusuario
  // que inició sesión), no el del negocio: con usuarios.nombre salía
  // «WAPP, tu WhatsApp…» en vez de «Daniel, tu WhatsApp…».
  const persona = String(req.sessionUser?.nombre_encargado || '').trim();
  if (data?.dueno) {
    data.dueno.empresa = data.dueno.nombre || null;
    if (persona) data.dueno.nombre = persona;
  }
  res.json({ status: 'success', data });
});

/* POST /api/v1/onboarding/implementacion/mostrado — el modal se abrió (métrica). */
exports.mostrado = catchAsync(async (req, res, next) => {
  const id_usuario = Number(req.sessionUser?.id_usuario);
  if (!id_usuario) return next(new AppError('Sesión sin cuenta', 401));
  await svc.marcarMostrado(id_usuario);
  res.json({ status: 'success' });
});

/* ── Oferta del complemento ImporKiller (2026-11-11) ──────────────────────
   Solo el administrador de la cuenta puede comprar complementos: a los demás
   roles el back les dice que no, aunque el front ya no pregunta por ellos. */
const esAdministrador = (req) => req.sessionUser?.rol === 'administrador';

/* GET /api/v1/onboarding/imporkiller → { mostrar, motivo, precio, en_trial, nombre } */
exports.imporkiller = catchAsync(async (req, res, next) => {
  const id_usuario = Number(req.sessionUser?.id_usuario);
  if (!id_usuario) return next(new AppError('Sesión sin cuenta', 401));
  if (!esAdministrador(req)) {
    return res.json({ status: 'success', data: { mostrar: false, motivo: 'no_administrador' } });
  }
  const data = await svc.estadoImporKiller(id_usuario);
  data.nombre = String(req.sessionUser?.nombre_encargado || '').trim() || null;
  res.json({ status: 'success', data });
});

/* POST /api/v1/onboarding/imporkiller/mostrado — el modal se abrió (métrica). */
exports.imporkillerMostrado = catchAsync(async (req, res, next) => {
  const id_usuario = Number(req.sessionUser?.id_usuario);
  if (!id_usuario) return next(new AppError('Sesión sin cuenta', 401));
  await svc.marcarMostrado(id_usuario, svc.AVISO_IMPORKILLER);
  res.json({ status: 'success' });
});

/* POST /api/v1/onboarding/imporkiller/no-mostrar — «No volver a mostrar». */
exports.imporkillerNoMostrar = catchAsync(async (req, res, next) => {
  const id_usuario = Number(req.sessionUser?.id_usuario);
  if (!id_usuario) return next(new AppError('Sesión sin cuenta', 401));
  if (!esAdministrador(req)) return next(new AppError('Solo el administrador de la cuenta', 403));
  const data = await svc.descartarImporKiller({
    id_usuario,
    id_sub_usuario: req.sessionUser?.id_sub_usuario || null,
  });
  res.json({ status: 'success', data });
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
