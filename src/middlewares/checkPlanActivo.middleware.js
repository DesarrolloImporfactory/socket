const Usuarios_chat_center = require('../models/usuarios_chat_center.model');
const Planes_chat_center = require('../models/planes_chat_center.model');

const checkPlanActivo = async (req, res, next) => {
  try {
    const sessionUser = req.sessionUser;

    if (!sessionUser?.id_usuario) {
      return res.status(401).json({
        status: 'fail',
        code: 'UNAUTHORIZED',
        message: 'Sesión inválida.',
        redirectTo: '/login',
      });
    }

    const usuario = await Usuarios_chat_center.findByPk(sessionUser.id_usuario);
    if (!usuario) {
      return res.status(404).json({
        status: 'fail',
        code: 'USER_NOT_FOUND',
        message: 'Usuario no encontrado.',
      });
    }

    // Bloqueos duros por estado (usted decide si permanente ignora suspendido/cancelado)
    if (usuario.estado === 'suspendido' || usuario.estado === 'cancelado') {
      return res.status(403).json({
        status: 'fail',
        code: 'ACCOUNT_BLOCKED',
        message: 'Su cuenta no tiene acceso en este momento.',
        redirectTo: '/planes',
      });
    }

    // Si es plan permanente, permitir (salvo regla de arriba)
    if (Number(usuario.permanente) === 1) {
      req.planInfo = { permanente: true };
      return next();
    }

    const ahora = new Date();

    // Trial vigente => permitir
    if (usuario.trial_end && ahora <= new Date(usuario.trial_end)) {
      req.planInfo = { trial: true, trial_end: usuario.trial_end };
      return next();
    }

    // Si no tiene plan asignado
    if (!usuario.id_plan) {
      return res.status(402).json({
        status: 'fail',
        code: 'PLAN_REQUIRED',
        message: 'No tiene un plan activo. Seleccione un plan para continuar.',
        redirectTo: '/planes',
      });
    }

    // Validar fecha de renovación (vencido)
    if (
      usuario.fecha_renovacion &&
      ahora > new Date(usuario.fecha_renovacion)
    ) {
      if (usuario.estado !== 'vencido') {
        await usuario.update({ estado: 'vencido' });
      }
      return res.status(402).json({
        status: 'fail',
        code: 'PLAN_EXPIRED',
        message: 'Su plan ha vencido. Debe renovarlo para continuar.',
        redirectTo: '/planes',
      });
    }

    // Si el estado no es activo, bloquear
    if (usuario.estado !== 'activo') {
      return res.status(403).json({
        status: 'fail',
        code: 'PLAN_INACTIVE',
        message: 'Su plan no está activo.',
        redirectTo: '/planes',
      });
    }

    // (Opcional pero recomendado) Validar que el plan exista y esté activo en el catálogo
    if (Planes_chat_center) {
      const plan = await Planes_chat_center.findByPk(usuario.id_plan);
      if (!plan || Number(plan.activo) !== 1) {
        return res.status(402).json({
          status: 'fail',
          code: 'PLAN_UNAVAILABLE',
          message: 'Su plan no está disponible. Seleccione otro plan.',
          redirectTo: '/planes',
        });
      }
      req.planInfo = { plan };
    }

    return next();
  } catch (err) {
    return next(err);
  }
};

module.exports = checkPlanActivo;
