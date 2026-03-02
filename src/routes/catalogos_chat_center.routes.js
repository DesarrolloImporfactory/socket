const express = require('express');
const router = express.Router();

const catalogosController = require('../controllers/catalogos_chat_center.controller');

const { protect } = require('../middlewares/auth.middleware');
const checkPlanActivo = require('../middlewares/checkPlanActivo.middleware');

router.use(protect);

router.post(
  '/listarCatalogos',
  checkPlanActivo,
  catalogosController.listarCatalogos,
);
router.post(
  '/obtenerCatalogo',
  checkPlanActivo,
  catalogosController.obtenerCatalogo,
);

router.post(
  '/crearCatalogo',
  checkPlanActivo,
  catalogosController.crearCatalogo,
);
router.post(
  '/actualizarCatalogo',
  checkPlanActivo,
  catalogosController.actualizarCatalogo,
);
router.delete(
  '/eliminarCatalogo',
  checkPlanActivo,
  catalogosController.eliminarCatalogo,
);

// items (productos seleccionados + orden)
router.post(
  '/guardarItemsCatalogo',
  checkPlanActivo,
  catalogosController.guardarItemsCatalogo,
);

// settings (campos a mostrar en landing)
router.post(
  '/guardarSettingsCatalogo',
  checkPlanActivo,
  catalogosController.guardarSettingsCatalogo,
);

module.exports = router;
