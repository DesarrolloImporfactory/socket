const configuracionesController = require('../controllers/configuraciones.controller');

const express = require('express');

const router = express.Router();

const {
  protect,
  protectConfigOwner,
} = require('../middlewares/auth.middleware');
const checkPlanActivo = require('../middlewares/checkPlanActivo.middleware');
const checkToolAccess = require('../middlewares/checkToolAccess.middleware');
const limiteConexiones = require('../middlewares/limiteConexiones.middleware');
const limiteConversaciones = require('../middlewares/limiteConversaciones.middleware');
const requireStripeSubscription = require('../middlewares/requireStripeSubscription.middleware');
const restrictToRoles = require('../middlewares/restrictTo.middleware');

// ── Guards ──
const imporchatGuard = [checkPlanActivo, checkToolAccess('imporchat')];

// wrapper que llama a tu limiteConexiones solo al reactivar
const validarReactivarConLimite = (req, res, next) => {
  const raw = req.body?.suspendido;
  const quiereActivar =
    raw === false ||
    raw === 0 ||
    raw === '0' ||
    String(raw).toLowerCase() === 'false';

  // Si es suspender, no validamos cupo
  if (!quiereActivar) return next();

  // Si es reactivar, usamos tu middleware tal cual
  return limiteConexiones(req, res, next);
};

router.use(protect);

router.post(
  '/obtener_template_transportadora',
  configuracionesController.obtener_template_transportadora,
);

router.post(
  '/validar_conexion_usuario',
  ...imporchatGuard,
  configuracionesController.validarConexionUsuario,
);

router.post(
  '/listar_conexiones',
  ...imporchatGuard,
  /* limiteConversaciones, */
  configuracionesController.listarConexiones,
);

router.post(
  '/listar_conexiones_sub_user',
  ...imporchatGuard,
  /* limiteConversaciones, */
  configuracionesController.listarConexionesSubUser,
);

router.post(
  '/listar_admin_conexiones',
  ...imporchatGuard,
  configuracionesController.listarAdminConexiones,
);

router.post(
  '/listar_configuraciones',
  configuracionesController.listarConfiguraciones,
);

router.post(
  '/agregarConfiguracion',
  ...imporchatGuard,
  restrictToRoles('administrador'),
  requireStripeSubscription,
  limiteConexiones,
  configuracionesController.agregarConfiguracion,
);
router.post(
  '/toggle_suspension',
  ...imporchatGuard,
  restrictToRoles('administrador'),
  validarReactivarConLimite,
  configuracionesController.toggleSuspension,
);

// Editar nombre + teléfono de una conexión no vinculada (sin límite de
// cupo: no crea conexión, solo corrige una existente).
router.post(
  '/editar_conexion',
  ...imporchatGuard,
  restrictToRoles('administrador'),
  configuracionesController.editarConexion,
);

router.post(
  '/exportar_mensajes_xlsx',
  ...imporchatGuard,
  protectConfigOwner,
  configuracionesController.exportarMensajesXLSX,
);

router.post(
  '/obtener_auto_orden_dropi',
  ...imporchatGuard,
  protectConfigOwner,
  configuracionesController.obtenerAutoOrdenDropi,
);

router.post(
  '/actualizar_auto_orden_dropi',
  ...imporchatGuard,
  protectConfigOwner,
  restrictToRoles('administrador'),
  configuracionesController.actualizarAutoOrdenDropi,
);

module.exports = router;
