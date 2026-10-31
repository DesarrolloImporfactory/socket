const requireSuperAdmin = require('./requireSuperAdmin.middleware');
const checkPlanActivo = require('./checkPlanActivo.middleware');
const checkToolAccess = require('./checkToolAccess.middleware');

/**
 * espiaAcceso — quién puede usar el Espía de mercado (/api/v1/espia).
 *
 * Hoy entra solo el super administrador de Imporfactory. La ruta para abrirlo
 * a clientes ya está tendida y no toca las rutas: cuando se decida venderlo,
 * se cambia la regla `espia_mercado` en checkToolAccess.middleware (qué planes
 * lo incluyen) y el menú del frontend; este middleware deja pasar a quien
 * tenga plan activo con esa herramienta.
 *
 * Debe ir después de protect (usa req.sessionUser).
 */
const porPlan = checkToolAccess('espia_mercado');

module.exports = (req, res, next) => {
  requireSuperAdmin(req, res, (errSuper) => {
    if (!errSuper) return next();
    if (errSuper.statusCode === 401) return next(errSuper);
    // No es super admin: ¿tiene un plan que incluya la herramienta?
    checkPlanActivo(req, res, (errPlan) => {
      if (errPlan) return next(errPlan);
      porPlan(req, res, next);
    });
  });
};
