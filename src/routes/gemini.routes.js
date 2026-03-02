const express = require('express');
const router = express.Router();

const { protect } = require('../middlewares/auth.middleware');
const checkPlanActivo = require('../middlewares/checkPlanActivo.middleware');
const geminiController = require('../controllers/gemini.controller');
const multer = require('multer');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024, files: 6 },
});

const uploadSingle = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
});

router.use(protect);

// ─── Catálogos públicos ──────────────────────────────────────────────────────
router.get('/etapas', geminiController.get_etapas);
router.get('/templates', geminiController.get_templates);

// ─── Consultas (requieren plan activo) ───────────────────────────────────────
router.get('/usage', checkPlanActivo, geminiController.get_usage);
router.get('/historial', checkPlanActivo, geminiController.get_historial);

// ─── Generación ──────────────────────────────────────────────────────────────
router.post(
  '/generar',
  checkPlanActivo,
  upload.array('user_images', 6),
  geminiController.generar_multipart,
);
router.post(
  '/generar-etapa',
  checkPlanActivo,
  upload.array('user_images', 6),
  geminiController.generar_etapa,
);

// ─── Admin: CRUD Templates ──────────────────────────────────────────────────
// TODO: agregar middleware de rol admin si lo tienes (ej: checkAdmin)
router.get('/admin/templates', geminiController.admin_list_templates);
router.post(
  '/admin/templates',
  uploadSingle.single('imagen'),
  geminiController.admin_create_template,
);
router.put(
  '/admin/templates/:id',
  uploadSingle.single('imagen'),
  geminiController.admin_update_template,
);
router.delete('/admin/templates/:id', geminiController.admin_delete_template);

// ─── Legacy ──────────────────────────────────────────────────────────────────
router.post(
  '/obtener_api_key',
  checkPlanActivo,
  geminiController.obtener_api_key,
);
router.post(
  '/guardar_api_key',
  checkPlanActivo,
  geminiController.guardar_api_key,
);

module.exports = router;
