const Usuarios_chat_center = require('../models/usuarios_chat_center.model');
const Planes_chat_center = require('../models/planes_chat_center.model');
const { db } = require('../database/config');

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

    // Bloqueos duros por estado
    if (usuario.estado === 'suspendido' || usuario.estado === 'cancelado') {
      return res.status(403).json({
        status: 'fail',
        code: 'ACCOUNT_BLOCKED',
        message: 'Su cuenta no tiene acceso en este momento.',
        redirectTo: '/planes',
      });
    }

    // Si es plan permanente, permitir
    if (Number(usuario.permanente) === 1) {
      req.planInfo = { permanente: true };
      return next();
    }

    const ahora = new Date();

    // ═══════════════════════════════════════════════════════
    // Trial por uso (Insta Landing)
    // ═══════════════════════════════════════════════════════
    if (usuario.estado === 'trial_usage') {
      if (!usuario.id_plan) {
        return res.status(402).json({
          status: 'fail',
          code: 'PLAN_REQUIRED',
          message: 'No tiene un plan asignado.',
          redirectTo: '/planes',
        });
      }

      const IL_TRIAL_LIMIT = 10;
      const usadas = Number(usuario.il_imagenes_usadas || 0);

      if (usadas >= IL_TRIAL_LIMIT) {
        return res.status(402).json({
          status: 'fail',
          code: 'TRIAL_EXHAUSTED',
          message:
            'Su prueba gratuita ha terminado. Suscríbase para continuar.',
          redirectTo: '/planes',
          trial_info: {
            used: usadas,
            limit: IL_TRIAL_LIMIT,
            remaining: 0,
          },
        });
      }

      req.planInfo = {
        trial_usage: true,
        il_imagenes_usadas: usadas,
        il_imagenes_limite: IL_TRIAL_LIMIT,
        il_imagenes_restantes: IL_TRIAL_LIMIT - usadas,
      };
      return next();
    }

    // ═══════════════════════════════════════════════════════
    // Promo usage (Código Promocional)
    // ═══════════════════════════════════════════════════════
    if (usuario.estado === 'promo_usage') {
      if (!usuario.id_plan) {
        return res.status(402).json({
          status: 'fail',
          code: 'PLAN_REQUIRED',
          message: 'No tiene un plan asignado.',
          redirectTo: '/planes',
        });
      }

      const imgRestantes = Number(usuario.promo_imagenes_restantes || 0);
      const angRestantes = Number(usuario.promo_angulos_restantes || 0);

      // Si ambos recursos están en 0, expiró
      if (imgRestantes <= 0 && angRestantes <= 0) {
        // Buscar info del último código canjeado para redirect y descripción
        let promoRedirect = null;
        let promoDescripcion = null;
        let promoCodigo = null;

        try {
          const [[canje]] = await db.query(
            `SELECT cp.redirect_on_exhaust, cp.descripcion, cp.codigo
             FROM canjes_codigo_promocional ccp
             JOIN codigos_promocionales cp ON cp.id_codigo = ccp.id_codigo
             WHERE ccp.id_usuario = ?
             ORDER BY ccp.fecha_canje DESC
             LIMIT 1`,
            { replacements: [sessionUser.id_usuario] },
          );
          if (canje) {
            promoRedirect = canje.redirect_on_exhaust || null;
            promoDescripcion = canje.descripcion || null;
            promoCodigo = canje.codigo || null;
          }
        } catch (e) {
          console.warn(
            '[checkPlanActivo] Error fetching promo info:',
            e?.message,
          );
        }

        return res.status(402).json({
          status: 'fail',
          code: 'PROMO_EXHAUSTED',
          message:
            'Sus recursos promocionales se agotaron. Suscríbase para continuar.',
          redirectTo: promoRedirect || '/planes',
          promo_info: {
            imagenes_restantes: 0,
            angulos_restantes: 0,
            redirect_url: promoRedirect,
            descripcion: promoDescripcion,
            codigo: promoCodigo,
          },
        });
      }

      // Aún tiene recursos, dejar pasar
      req.planInfo = {
        promo_usage: true,
        promo_imagenes_restantes: imgRestantes,
        promo_angulos_restantes: angRestantes,
      };
      return next();
    }

    // Trial vigente (Stripe trial) y estado es activo => permitir
    if (
      usuario.trial_end &&
      ahora <= new Date(usuario.trial_end) &&
      usuario.estado === 'activo'
    ) {
      let plan = null;
      if (usuario.id_plan) {
        plan = await Planes_chat_center.findByPk(usuario.id_plan);
      }
      req.planInfo = { trial: true, trial_end: usuario.trial_end, plan };
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

    // Validar que el plan exista y esté activo en el catálogo
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
