const express = require('express');
const router = express.Router();

const { protect } = require('../middlewares/auth.middleware');
const checkPlanActivo = require('../middlewares/checkPlanActivo.middleware');

const dashboardController = require('../controllers/dashboard.controller');

router.use(protect);

// ── Filtros (compartido admin y agente) ────────────────────────────────
router.post(
  '/obtener_filtros',
  checkPlanActivo,
  dashboardController.obtenerFiltrosDashboard,
);

// ── Dashboard ADMIN — ve todas las métricas de la cuenta ───────────────
router.post(
  '/obtener_dashboard_completo',
  checkPlanActivo,
  dashboardController.obtenerDashboardCompleto,
);

// ── Dashboard AGENTE — ve solo sus propias métricas ────────────────────
// Si el sub-usuario ES admin, retorna todo igual que el completo.
// Si NO es admin, filtra por ccc.id_encargado = id_sub_usuario.
router.post(
  '/obtener_dashboard_agente',
  checkPlanActivo,
  dashboardController.obtenerDashboardAgente,
);

module.exports = router;
