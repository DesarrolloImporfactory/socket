const router = require('express').Router();
const ctrl = require('../controllers/kanban_plantillas.controller');

const { protect } = require('../middlewares/auth.middleware');
const requireSuperAdmin = require('../middlewares/requireSuperAdmin.middleware');

router.post('/listar', ctrl.listar);
router.post('/aplicar', ctrl.aplicar);
router.post('/reiniciar', ctrl.reiniciar);

/* plantillas propias guardadas  */
router.post('/guardar_cliente', ctrl.guardarCliente);
router.post('/listar_cliente', ctrl.listarCliente);
router.post('/aplicar_cliente', ctrl.aplicarCliente);
router.post('/eliminar_cliente', ctrl.eliminarCliente);

// guardar_global: SOLO super_administrador (cierra el agujero del localStorage)
router.post('/guardar_global', protect, requireSuperAdmin, ctrl.guardarGlobal);

router.post('/listar_globales', ctrl.listarGlobales);

router.post('/aplicar_global', ctrl.aplicarGlobal);

// eliminar_global: SOLO super_administrador
router.post(
  '/eliminar_global',
  protect,
  requireSuperAdmin,
  ctrl.eliminarGlobal,
);

/* templates Meta + respuestas rápidas */
router.post('/crear_templates_meta', ctrl.crearTemplatesMeta);
router.post('/crear_respuestas_rapidas', ctrl.crearRespuestasRapidas);
router.get('/t/:guide', ctrl.trackingRedirect);

/* personalización por columna */
router.post('/personalizacion_obtener', ctrl.personalizacionObtener);
router.post('/personalizacion_preview', ctrl.personalizacionPreview);
router.post('/personalizacion_actualizar', ctrl.personalizacionActualizar);
router.post(
  '/personalizacion_resincronizar',
  ctrl.personalizacionResincronizar,
);
router.post(
  '/personalizacion_resincronizar_masivo',
  ctrl.personalizacionResincronizarMasivo,
);

module.exports = router;
