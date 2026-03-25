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

module.exports = router;
