const express = require('express');
const router = express.Router();

const { protect } = require('../middlewares/auth.middleware');
const checkPlanActivo = require('../middlewares/checkPlanActivo.middleware');

const dashboardController = require('../controllers/dashboard.controller');

router.use(protect);

router.post(
  '/obtener_filtros',
  checkPlanActivo,
  dashboardController.obtenerFiltrosDashboard,
);

router.post(
  '/obtener_dashboard_completo',
  checkPlanActivo,
  dashboardController.obtenerDashboardCompleto,
);

module.exports = router;
