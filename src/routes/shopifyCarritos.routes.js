const express = require('express');
const router = express.Router();
const controller = require('../controllers/shopifyCarritosListController');

router.get('/', controller.listar);
router.get('/estadisticas', controller.estadisticas);
router.patch('/:id/marcar-mensaje-enviado', controller.marcarMensajeEnviado);

module.exports = router;