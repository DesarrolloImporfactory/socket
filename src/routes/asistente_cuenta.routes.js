// routes/asistente_cuenta.routes.js — chat flotante de métricas de la cuenta.
const express = require('express');
const controller = require('../controllers/asistente_cuenta.controller');
const {
  protect,
  protectConfigOwner,
} = require('../middlewares/auth.middleware');

const router = express.Router();

// protectConfigOwner es obligatorio: las consultas filtran por el
// id_configuracion del body, así que tiene que pertenecer a la sesión.
router.post('/preguntar', protect, protectConfigOwner, controller.preguntar);

module.exports = router;
