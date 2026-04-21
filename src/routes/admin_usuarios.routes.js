const express = require('express');
const router = express.Router();

const { protect } = require('../middlewares/auth.middleware');
const requireSuperAdmin = require('../middlewares/requireSuperAdmin.middleware');

const ctrl = require('../controllers/admin_usuarios.controller');

// Todas las rutas requieren sesión + rol super_administrador
router.use(protect);
router.use(requireSuperAdmin);

router.post('/listar', ctrl.listarUsuariosAdmin);
router.get('/detalle/:id_usuario', ctrl.detalleUsuarioAdmin);
router.post('/exportar', ctrl.exportarUsuariosAdmin);
router.get('/kpis', ctrl.kpisUsuariosAdmin);

module.exports = router;
