const express = require('express');
const router = express.Router();

const { protect } = require('../middlewares/auth.middleware');
const checkPlanActivo = require('../middlewares/checkPlanActivo.middleware');
const checkToolAccess = require('../middlewares/checkToolAccess.middleware');
const requireStripeSubscription = require('../middlewares/requireStripeSubscription.middleware');
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

// ── Guards ──
const ilGuard = [checkPlanActivo, checkToolAccess('insta_landing')];

router.use(protect);

// ─── Catálogos públicos ──────────────────────────────────────────────────────
router.get('/etapas', geminiController.get_etapas);
router.get('/templates', geminiController.get_templates);

// ─── Consultas (requieren plan activo + insta landing) ───────────────────────
router.get('/usage', ...ilGuard, geminiController.get_usage);
router.get('/historial', ...ilGuard, geminiController.get_historial);

// ─── Negocios del usuario (configuraciones) ─────────────────────────────────
router.get('/mis-negocios', ...ilGuard, productosCtrl.listar_mis_negocios);

// ─── Productos IA (CRUD) ─────────────────────────────────────────────────────
router.get('/productos', ...ilGuard, productosCtrl.listar_productos);
router.get('/productos/:id', ...ilGuard, productosCtrl.obtener_producto);
router.post('/productos', ...ilGuard, productosCtrl.crear_producto);
router.put('/productos/:id', ...ilGuard, productosCtrl.actualizar_producto);
router.delete('/productos/:id', ...ilGuard, productosCtrl.eliminar_producto);
router.patch(
  '/productos/:id/portada',
  ...ilGuard,
  productosCtrl.asignar_portada,
);
router.patch(
  '/productos/:id/portada-upload',
  ...ilGuard,
  uploadSingle.single('imagen_portada'),
  productosCtrl.subir_portada,
);
router.post(
  '/productos/:id/asignar-imagenes',
  ...ilGuard,
  productosCtrl.asignar_imagenes,
);

// ─── Alimentar negocio con IA ────────────────────────────────────────────────
router.post(
  '/productos/:id/alimentar-negocio',
  ...ilGuard,
  productosCtrl.alimentar_negocio,
);

// ─── Importar desde Dropi → productos_ia ────────────────────────────────────
router.post(
  '/dropi/productos',
  ...ilGuard,
  productosCtrl.listar_dropi_productos,
);
router.post('/dropi/importar', ...ilGuard, productosCtrl.importar_desde_dropi);

// ─── Ángulos de venta (IA texto) ─────────────────────────────────────────────
router.post(
  '/generar-angulos',
  ...ilGuard,
  requireStripeSubscription,
  geminiController.generar_angulos,
);

// ─── Generación ──────────────────────────────────────────────────────────────
router.post(
  '/generar',
  ...ilGuard,
  requireStripeSubscription,
  upload.array('user_images', 6),
  geminiController.generar_multipart,
);
router.post(
  '/generar-etapa',
  ...ilGuard,
  requireStripeSubscription,
  upload.array('user_images', 6),
  geminiController.generar_etapa,
);

// ─── Regeneración ────────────────────────────────────────────────────────────
router.post(
  '/regenerar-etapa',
  ...ilGuard,
  requireStripeSubscription,
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
router.get('/mis-templates', ...ilGuard, templatePrivadosCtrl.listar);
router.post(
  '/mis-templates',
  ...ilGuard,
  uploadSingle.single('imagen'),
  templatePrivadosCtrl.crear,
);
router.delete('/mis-templates/:id', ...ilGuard, templatePrivadosCtrl.eliminar);

// ─── Legacy ──────────────────────────────────────────────────────────────────
router.post('/obtener_api_key', ...ilGuard, geminiController.obtener_api_key);
router.post('/guardar_api_key', ...ilGuard, geminiController.guardar_api_key);

module.exports = router;
