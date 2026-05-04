const router = require('express').Router();
const ctrl = require('../controllers/kanban_plantillas_admin.controller');

const { protect } = require('../middlewares/auth.middleware');
const requireSuperAdmin = require('../middlewares/requireSuperAdmin.middleware');

router.use(protect);
router.use(requireSuperAdmin);

// ── Lectura ───────────────────────────────────────────────────
router.post('/listar', ctrl.listar);
router.post('/obtener', ctrl.obtener);
router.post('/uso', ctrl.uso);

// ── Escritura ─────────────────────────────────────────────────
router.post('/crear', ctrl.crear);
router.post('/actualizar_metadata', ctrl.actualizarMetadata);
router.post('/actualizar_data', ctrl.actualizarData);
router.post('/duplicar', ctrl.duplicar);

// ── Eliminación ───────────────────────────────────────────────
router.post('/eliminar', ctrl.eliminar); // soft delete (activo=0)
router.post('/restaurar', ctrl.restaurar); // reactivar
router.post('/eliminar_definitivo', ctrl.eliminarDefinitivo); // hard delete (solo si nadie la usa)

module.exports = router;
