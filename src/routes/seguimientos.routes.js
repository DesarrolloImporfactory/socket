const express = require('express');
const router = express.Router();
const { protect } = require('../middlewares/auth.middleware');
const requireGestorClientes = require('../middlewares/requireGestorClientes.middleware');
const ctrl = require('../controllers/seguimientos.controller');

router.use(protect);
router.use(requireGestorClientes);

router.get('/proximos', ctrl.proximos);
router.get('/:id_usuario', ctrl.listar);
router.post('/', ctrl.crear);
router.put('/:id_seguimiento', ctrl.editar);
router.delete('/evidencia/:id_evidencia', ctrl.eliminarEvidencia);
router.delete('/:id_seguimiento', ctrl.eliminar);

module.exports = router;
