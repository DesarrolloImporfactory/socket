const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/encuestas.controller');
const { protect } = require('../middlewares/auth.middleware');

router.use(protect);

// Listar encuestas de una conexión
router.get('/listar', ctrl.listarPorConexion);

// Stats de una encuesta
router.get('/:id/stats', ctrl.stats);

// Respuestas paginadas
router.get('/:id/respuestas', ctrl.listarRespuestas);

// CRUD
router.post('/crear', ctrl.crear);
router.put('/:id', ctrl.actualizar);
router.patch('/:id/toggle', ctrl.toggleActiva);
router.delete('/:id', ctrl.eliminar);

router.get('/cliente/:id_cliente/respuestas', ctrl.respuestasPorCliente);
module.exports = router;
