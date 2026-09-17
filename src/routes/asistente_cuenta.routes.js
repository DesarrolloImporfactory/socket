// routes/asistente_cuenta.routes.js — chat flotante de métricas de la cuenta.
const express = require('express');
const controller = require('../controllers/asistente_cuenta.controller');
const {
  protect,
  protectConfigOwner,
} = require('../middlewares/auth.middleware');

const router = express.Router();

/* Con id_configuracion hay que validar que sea de la sesión: las consultas
   filtran por ese id. Sin él, el asistente entra en modo general (solo videos
   tutoriales e integraciones), que no toca datos de ninguna cuenta. */
const validarConfigSiViene = (req, res, next) =>
  req.body?.id_configuracion ? protectConfigOwner(req, res, next) : next();

router.post(
  '/preguntar',
  protect,
  validarConfigSiViene,
  controller.preguntar,
);

module.exports = router;
