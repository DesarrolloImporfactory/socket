const express = require('express');
const router = express.Router();

const auth = require('../middlewares/auth.middleware');
const ctrl = require('../controllers/tutoriales.controller');

router.use(auth.protect);

// ── Público (cualquier usuario autenticado de Imporchat) ──
router.get('/', ctrl.listPublic);
router.post('/progreso', ctrl.marcarProgreso);

// ── Admin (solo super_administrador): CRUD de qué módulos se muestran ──
router.get('/admin/cursos', auth.requireSuperAdmin, ctrl.adminListCursos);
router.post('/admin/modulos', auth.requireSuperAdmin, ctrl.adminUpsertModulo);
router.delete(
  '/admin/modulos/:id_modulo',
  auth.requireSuperAdmin,
  ctrl.adminDeleteModulo,
);

module.exports = router;
