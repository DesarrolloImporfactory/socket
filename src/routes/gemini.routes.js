const express = require('express');
const router = express.Router();

const { protect } = require('../middlewares/auth.middleware');
const checkPlanActivo = require('../middlewares/checkPlanActivo.middleware');
const geminiController = require('../controllers/gemini.controller');
const productosCtrl = require('../controllers/productos_ia.controller');
const templatePrivadosCtrl = require('../controllers/templates_ia.privados.controller');
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

// ─── Negocios del usuario (configuraciones) ─────────────────────────────────
router.get('/mis-negocios', checkPlanActivo, productosCtrl.listar_mis_negocios);

// ─── Productos IA (CRUD) ─────────────────────────────────────────────────────
router.get('/productos', checkPlanActivo, productosCtrl.listar_productos);
router.get('/productos/:id', checkPlanActivo, productosCtrl.obtener_producto);
router.post('/productos', checkPlanActivo, productosCtrl.crear_producto);
router.put(
  '/productos/:id',
  checkPlanActivo,
  productosCtrl.actualizar_producto,
);
router.delete(
  '/productos/:id',
  checkPlanActivo,
  productosCtrl.eliminar_producto,
);
router.patch(
  '/productos/:id/portada',
  checkPlanActivo,
  productosCtrl.asignar_portada,
);
router.patch(
  '/productos/:id/portada-upload',
  checkPlanActivo,
  uploadSingle.single('imagen_portada'),
  productosCtrl.subir_portada,
);
router.post(
  '/productos/:id/asignar-imagenes',
  checkPlanActivo,
  productosCtrl.asignar_imagenes,
);

// ─── Alimentar negocio con IA ────────────────────────────────────────────────
router.post(
  '/productos/:id/alimentar-negocio',
  checkPlanActivo,
  productosCtrl.alimentar_negocio,
);

// ─── Importar desde Dropi → productos_ia ────────────────────────────────────
router.post(
  '/dropi/productos',
  checkPlanActivo,
  productosCtrl.listar_dropi_productos,
);
router.post(
  '/dropi/importar',
  checkPlanActivo,
  productosCtrl.importar_desde_dropi,
);

// ─── Ángulos de venta (IA texto) ─────────────────────────────────────────────
router.post(
  '/generar-angulos',
  checkPlanActivo,
  geminiController.generar_angulos,
);

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

// ─── Regeneración ────────────────────────────────────────────────────────────
router.post(
  '/regenerar-etapa',
  checkPlanActivo,
  upload.array('user_images', 6),
  geminiController.regenerar_etapa,
);

// ─── Admin: CRUD Templates ──────────────────────────────────────────────────
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

// ─── Templates Privados del usuario ──────────────────────────────────────────
router.get('/mis-templates', checkPlanActivo, templatePrivadosCtrl.listar);
router.post(
  '/mis-templates',
  checkPlanActivo,
  uploadSingle.single('imagen'),
  templatePrivadosCtrl.crear,
);
router.delete(
  '/mis-templates/:id',
  checkPlanActivo,
  templatePrivadosCtrl.eliminar,
);

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
