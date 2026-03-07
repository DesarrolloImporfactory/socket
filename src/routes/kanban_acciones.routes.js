// routes/kanban_acciones.routes.js
const express = require('express');
const router = express.Router();
const KanbanAccionesController = require('../controllers/kanban_acciones.controller');

// Todas las rutas usan POST para mantener consistencia con el resto de la API

router.post('/listar', KanbanAccionesController.listar);
router.post('/crear', KanbanAccionesController.crear);
router.post('/actualizar', KanbanAccionesController.actualizar);
router.post('/eliminar', KanbanAccionesController.eliminar);

module.exports = router;

// ─── Registro en app.js / index.js ───────────────────────────
// const kanbanAccionesRouter = require('./routes/kanban_acciones.routes');
// app.use('/kanban_acciones', kanbanAccionesRouter);
