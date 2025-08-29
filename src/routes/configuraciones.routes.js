const configuracionesController = require('../controllers/configuraciones.controller');

const express = require('express');

const router = express.Router();

const { protect } = require('../middlewares/auth.middleware');
const checkPlanActivo = require('../middlewares/checkPlanActivo.middleware');
const limiteConexiones = require('../middlewares/limiteConexiones.middleware');

// wrapper que llama a tu limiteConexiones solo al reactivar
const validarReactivarConLimite = (req, res, next) => {
  const raw = req.body?.suspendido;
  const quiereActivar =
    raw === false || raw === 0 || raw === '0' || String(raw).toLowerCase() === 'false';

  // Si es suspender, no validamos cupo
  if (!quiereActivar) return next();

  // Si es reactivar, usamos tu middleware tal cual
  return limiteConexiones(req, res, next);
};

router.use(protect);



router.post(
  '/obtener_template_transportadora',
  configuracionesController.obtener_template_transportadora
);

router.post(
  '/validar_conexion_usuario',
  configuracionesController.validarConexionUsuario
);

router.post(
  '/listar_conexiones',
  checkPlanActivo,
  configuracionesController.listarConexiones
);

router.post(
  '/listar_configuraciones',
  configuracionesController.listarConfiguraciones
);

router.post(
  '/agregarConfiguracion',
  limiteConexiones,
  configuracionesController.agregarConfiguracion
);
router.post(
  '/toggle_suspension', 
  validarReactivarConLimite,
  configuracionesController.toggleSuspension
);


module.exports = router;
