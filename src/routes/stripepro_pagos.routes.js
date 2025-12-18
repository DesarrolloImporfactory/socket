const express = require('express');
const router = express.Router();
const validationMiddleware = require('../middlewares/validations.middleware');

/**
 * Productos
 */

// Crear el producto y el precio en Stripe
const stripeproPagosController = require('../controllers/stripepro_pagos.controller');


/* sistema de pagos */
router.post('/crearSesionPago', stripeproPagosController.crearSesionPago);

module.exports = router;
