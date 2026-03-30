/**
 * checkToolAccess — Middleware factory para validar acceso a herramientas.
 *
 * DEBE ejecutarse DESPUÉS de checkPlanActivo (que setea req.planInfo).
 *
 * Uso en rutas:
 *   const checkToolAccess = require('../middlewares/checkToolAccess.middleware');
 *
 *   router.post('/dashboard/stats', checkPlanActivo, checkToolAccess('dropiboard'), ctrl.getDashboardStats);
 *   router.post('/some-route',      checkPlanActivo, checkToolAccess('imporchat'),  ctrl.someHandler);
 *   router.post('/other-route',     checkPlanActivo, checkToolAccess('insta_landing'), ctrl.someHandler);
 *
 * Reglas de acceso (basadas en tools_access del plan):
 *   - 'imporchat'     → requiere tools_access = 'imporchat' o 'both'
 *   - 'insta_landing'  → requiere tools_access = 'insta_landing' o 'both'
 *   - 'dropiboard'    → requiere tools_access = 'both'
 *
 * Escenarios de req.planInfo que setea checkPlanActivo:
 *   1. { permanente: true }                          → acceso total
 *   2. { trial_usage: true, il_imagenes_* }          → solo insta_landing
 *   3. { promo_usage: true, promo_*_restantes }      → solo insta_landing
 *   4. { trial: true, trial_end }                    → Stripe trial (7d), cargar plan para verificar tools_access
 *   5. { plan: <SequelizeModel> }                    → plan normal activo, leer plan.tools_access
 */

const Planes_chat_center = require('../models/planes_chat_center.model');

const TOOL_RULES = {
  imporchat: (access) => access === 'imporchat' || access === 'both',
  insta_landing: (access) => access === 'insta_landing' || access === 'both',
  dropiboard: (access) => access === 'both',
};

const TOOL_LABELS = {
  imporchat: 'ImporChat',
  insta_landing: 'Insta Landing',
  dropiboard: 'Dropiboard',
};

const checkToolAccess = (requiredTool) => {
  const checkFn = TOOL_RULES[requiredTool];
  const toolLabel = TOOL_LABELS[requiredTool] || requiredTool;

  if (!checkFn) {
    throw new Error(
      `[checkToolAccess] Herramienta desconocida: "${requiredTool}". Opciones: ${Object.keys(TOOL_RULES).join(', ')}`,
    );
  }

  return async (req, res, next) => {
    const planInfo = req.planInfo;

    // ── Sin planInfo → checkPlanActivo no corrió o falló ──
    if (!planInfo) {
      return res.status(403).json({
        status: 'fail',
        code: 'TOOL_ACCESS_DENIED',
        message: `No tiene acceso a ${toolLabel}. Requiere un plan activo.`,
        redirectTo: '/planes',
      });
    }

    // ── 1. Permanente → acceso total a todo ──
    if (planInfo.permanente) {
      return next();
    }

    // ── 2. Trial usage (IL, 10 imágenes gratis, sin Stripe) → solo insta_landing ──
    if (planInfo.trial_usage) {
      if (requiredTool === 'insta_landing') return next();
      return res.status(403).json({
        status: 'fail',
        code: 'TOOL_ACCESS_DENIED',
        message: `Su prueba gratuita solo incluye Insta Landing. Suscríbase para acceder a ${toolLabel}.`,
        redirectTo: '/planes',
      });
    }

    // ── 3. Promo usage (código promocional, sin Stripe) → solo insta_landing ──
    if (planInfo.promo_usage) {
      if (requiredTool === 'insta_landing') return next();
      return res.status(403).json({
        status: 'fail',
        code: 'TOOL_ACCESS_DENIED',
        message: `Su acceso promocional solo incluye Insta Landing. Suscríbase para acceder a ${toolLabel}.`,
        redirectTo: '/planes',
      });
    }

    // ── 4 y 5: Stripe trial o plan normal → verificar tools_access ──
    let toolsAccess = '';

    if (planInfo.plan) {
      // Caso 5: plan normal activo, o trial con plan precargado desde checkPlanActivo
      toolsAccess = (planInfo.plan.tools_access || '').toLowerCase().trim();
    } else if (planInfo.trial) {
      // Caso 4 (fallback): Stripe trial sin plan precargado
      try {
        const id_usuario = req.sessionUser?.id_usuario;
        if (id_usuario) {
          const usuario =
            await require('../models/usuarios_chat_center.model').findByPk(
              id_usuario,
            );
          if (usuario?.id_plan) {
            const plan = await Planes_chat_center.findByPk(usuario.id_plan);
            toolsAccess = (plan?.tools_access || '').toLowerCase().trim();
          }
        }
      } catch (e) {
        console.warn(
          '[checkToolAccess] Error loading plan for trial user:',
          e?.message,
        );
      }
    }

    // Verificar acceso
    if (checkFn(toolsAccess)) {
      return next();
    }

    return res.status(403).json({
      status: 'fail',
      code: 'TOOL_ACCESS_DENIED',
      message: `Su plan no incluye acceso a ${toolLabel}. Actualice su plan para desbloquear esta herramienta.`,
      redirectTo: '/planes',
    });
  };
};

module.exports = checkToolAccess;
