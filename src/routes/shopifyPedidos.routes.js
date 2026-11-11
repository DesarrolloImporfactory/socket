const express = require('express');
const router = express.Router();
const controller = require('../controllers/shopify_pedidos.controller');
const { protect, protectConfigOwner } = require('../middlewares/auth.middleware');

// Vista Pedidos: pedidos recibidos por el webhook de Shopify, para cuentas
// que no tienen Dropi ni Aliclik. Requiere sesión + que la id_configuracion
// pertenezca a la cuenta.
router.post('/list', protect, protectConfigOwner, controller.listOrders);

module.exports = router;
