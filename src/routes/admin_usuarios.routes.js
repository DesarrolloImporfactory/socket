const express = require('express');
const router = express.Router();

const { protect } = require('../middlewares/auth.middleware');
const requireSuperAdmin = require('../middlewares/requireSuperAdmin.middleware');
const requireGestorClientes = require('../middlewares/requireGestorClientes.middleware');
const ctrl = require('../controllers/admin_usuarios.controller');

// Todas las rutas requieren sesión + rol super_administrador
router.use(protect);

router.post('/listar', requireGestorClientes, ctrl.listarUsuariosAdmin);
router.get(
  '/detalle/:id_usuario',
  requireGestorClientes,
  ctrl.detalleUsuarioAdmin,
);
// Exportar → solo super_administrador
router.post('/exportar', requireSuperAdmin, ctrl.exportarUsuariosAdmin);
router.get('/kpis', requireGestorClientes, ctrl.kpisUsuariosAdmin);
// Métricas de gestión del asesor (evolución, embudo, cobertura, agenda)
router.get(
  '/metricas_gestion',
  requireGestorClientes,
  ctrl.metricasGestionAdmin,
);

module.exports = router;
