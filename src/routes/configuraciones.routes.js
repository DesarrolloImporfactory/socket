const configuracionesController = require('../controllers/configuraciones.controller');

const express = require('express');

const router = express.Router();

const { protect } = require('../middlewares/auth.middleware');
const checkPlanActivo = require('../middlewares/checkPlanActivo.middleware');

router.use(protect);

router.post(
  '/obtener_template_transportadora',
  configuracionesController.obtener_template_transportadora
);

router.post(
  '/listar_conexiones',
  checkPlanActivo,
  configuracionesController.listarConexiones
);

module.exports = router;
