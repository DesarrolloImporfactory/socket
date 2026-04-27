// kanban_plantillas.routes.js
const router = require('express').Router();
const ctrl = require('../controllers/kanban_plantillas.controller');
router.post('/listar', ctrl.listar);
router.post('/aplicar', ctrl.aplicar);
router.post('/reiniciar', ctrl.reiniciar);

/* plantillas propias guardadas  */

router.post('/guardar_cliente', ctrl.guardarCliente);
router.post('/listar_cliente', ctrl.listarCliente);
router.post('/aplicar_cliente', ctrl.aplicarCliente);
router.post('/eliminar_cliente', ctrl.eliminarCliente);

/* plantillas globales guardadas  */
router.post('/guardar_global', ctrl.guardarGlobal);
router.post('/listar_globales', ctrl.listarGlobales);
router.post('/aplicar_global', ctrl.aplicarGlobal);
router.post('/eliminar_global', ctrl.eliminarGlobal);

/* ── NUEVOS: templates Meta + respuestas rápidas ── */
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

module.exports = router;
