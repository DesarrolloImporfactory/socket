const departamentos_chat_center = require('../controllers/departamentos_chat_center.controller');

const express = require('express');

const router = express.Router();

const { protect } = require('../middlewares/auth.middleware');
const checkPlanActivo = require('../middlewares/checkPlanActivo.middleware');

router.use(protect);

router.post(
  '/listarDepartamentos',
  checkPlanActivo,
  departamentos_chat_center.listarDepartamentos
);

router.post(
  '/agregarDepartamento',
  departamentos_chat_center.agregarDepartamento
);

router.post(
  '/actualizarDepartamento',
  departamentos_chat_center.actualizarDepartamento
);

router.delete(
  '/eliminarDepartamento',
  departamentos_chat_center.eliminarDepartamento
);

module.exports = router;
