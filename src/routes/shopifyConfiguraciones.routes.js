const express = require('express');
const router = express.Router();
const controller = require('../controllers/shopifyConfiguracionesController');

router.get('/', controller.listar);
router.post('/', controller.crear);
router.patch('/:id', controller.editar);
router.delete('/:id', controller.eliminar);
router.post('/:id/actualizar-secret', controller.actualizarSecret);

module.exports = router;
