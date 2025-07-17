const facturas_cotController = require('../controllers/facturas_cot.controller');

const express = require('express');

const router = express.Router();

/* const authMiddleware = require('../middlewares/auth.middleware'); */

// routes/detalle_fact_cot.routes.js
router.post('/validarDevolucion', facturas_cotController.validarDevolucion);

// Ruta para generar la guía
router.post('/generar_guia', facturas_cotController.generarGuia);

router.post('/info-cliente', facturas_cotController.infoCliente);

router.post('/marcar_chat_center', facturas_cotController.marcarChatCenter);

module.exports = router;
