const express = require('express');
const planesController = require('../controllers/planes.controller');
const { protect } = require('../middlewares/auth.middleware');
const restrictToRoles = require('../middlewares/restrictTo.middleware');

const router = express.Router();
router.use(protect);

router.get('/listarPlanes', planesController.obtenerPlanes);

// Cambiar el plan de la cuenta es del administrador, no de un subusuario.
router.post(
  '/seleccionarPlan',
  restrictToRoles('administrador'),
  planesController.seleccionarPlan,
);

module.exports = router;
