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

// router.post('/migrar_todas_conexiones', ctrl.migrarTodasLasConexiones);
module.exports = router;
