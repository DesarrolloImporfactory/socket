const express = require('express');
const router = express.Router();
const { protect } = require('../middlewares/auth.middleware');
const ctrl = require('../controllers/etiquetas_custom_chat_center.controller');

router.use(protect);

// Catálogo de opciones
router.get('/listar', ctrl.listar); // ?tipo=asesor|ciclo
router.post('/crear', ctrl.crear); // { tipo, nombre }
router.delete('/eliminar/:id', ctrl.eliminar); // soft delete

// Asignación a cliente
router.post('/asignar', ctrl.asignar); // { id_cliente, tipo, id_etiqueta }
router.get('/cliente/:id_cliente', ctrl.obtenerPorCliente); // etiquetas del cliente

module.exports = router;
