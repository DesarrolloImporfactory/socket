const express = require('express');
const router = express.Router();

const { protect } = require('../middlewares/auth.middleware');
const checkPlanActivo = require('../middlewares/checkPlanActivo.middleware');

const excluirRoles = require('../middlewares/excluirRoles.middleware');

const dashboardController = require('../controllers/dashboard.controller');

router.use(protect);

/* Los controllers deciden "admin o agente" con el id_sub_usuario del body, y
   sin ese campo asumían dueño (todas las métricas). Un subusuario podía
   omitirlo o mandar el id de otro agente. La cuenta y el subusuario salen
   siempre de la sesión: protect ya cargó la fila de sub_usuarios_chat_center. */
const subUsuarioDeSesion = (req, res, next) => {
  req.body = req.body || {};
  req.body.id_usuario = req.sessionUser.id_usuario;
  req.body.id_sub_usuario = req.sessionUser.id_sub_usuario;
  next();
};
router.use(subUsuarioDeSesion);

// ── Filtros (compartido admin y agente) ────────────────────────────────
router.post(
  '/obtener_filtros',
  checkPlanActivo,
  dashboardController.obtenerFiltrosDashboard,
);

// ── Dashboard ADMIN — ve todas las métricas de la cuenta ───────────────
// Un asesor de ventas solo tiene el dashboard de agente (sus chats).
router.post(
  '/obtener_dashboard_completo',
  checkPlanActivo,
  excluirRoles('ventas'),
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
