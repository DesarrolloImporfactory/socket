// kanban_plantillas.routes.js
const router = require('express').Router();
const ctrl = require('../controllers/kanban_plantillas.controller');
router.post('/listar', ctrl.listar);
router.post('/aplicar', ctrl.aplicar);
router.post('/reiniciar', ctrl.reiniciar);

module.exports = router;
