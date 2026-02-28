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
  '/obtener_estadisticas',
  checkPlanActivo,
  dashboardController.obtenerEstadisticas,
);

router.post(
  '/obtener_cola_pendientes',
  checkPlanActivo,
  dashboardController.obtenerColaPendientes,
);

router.post(
  '/obtener_sla_hoy',
  checkPlanActivo,
  dashboardController.obtenerSlaHoy,
);

router.post(
  '/obtener_charts',
  checkPlanActivo,
  dashboardController.obtenerCharts,
);

module.exports = router;
