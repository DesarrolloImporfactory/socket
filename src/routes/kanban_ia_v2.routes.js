// routes/kanban_ia_v2.routes.js
const express = require('express');
const router = express.Router();
const KanbanIaV2Controller = require('../controllers/kanban_ia_v2.controller');

router.post('/config/listar', KanbanIaV2Controller.listar);
router.post('/config/obtener', KanbanIaV2Controller.obtener);
router.post('/config/guardar', KanbanIaV2Controller.guardar);
router.post('/config/eliminar', KanbanIaV2Controller.eliminar);
router.post('/config/usar_seed_sara', KanbanIaV2Controller.usarSeedSara);
router.post('/config/cargar_config', KanbanIaV2Controller.cargarConfig);

router.post('/probar', KanbanIaV2Controller.probar);

module.exports = router;
