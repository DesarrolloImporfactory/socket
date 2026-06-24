const router = require('express').Router();
const ctrl = require('../controllers/kanban_plantillas_admin.controller');

const { protect } = require('../middlewares/auth.middleware');
const requireSuperAdmin = require('../middlewares/requireSuperAdmin.middleware');

const multer = require('multer');
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 120 * 1024 * 1024 },
});

router.use(protect);
router.use(requireSuperAdmin);

// ── Lectura ───────────────────────────────────────────────────
router.post('/listar', ctrl.listar);
router.post('/obtener', ctrl.obtener);
router.post('/uso', ctrl.uso);

// Catálogo de ítems para las checklists del editor (setup variable).
router.post('/catalogo_setup', ctrl.catalogoSetup);

// ── Catálogo de items (CRUD del setup) ──
router.post('/catalogo_item_listar', ctrl.catalogoItemListar);
router.post('/catalogo_item_crear', ctrl.catalogoItemCrear);
router.post('/catalogo_item_actualizar', ctrl.catalogoItemActualizar);
router.post('/catalogo_item_eliminar', ctrl.catalogoItemEliminar);

// ── Subir media (respuestas rápidas / templates) ──
router.post(
  '/catalogo_subir_media',
  upload.single('file'),
  ctrl.catalogoSubirMedia,
);

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
