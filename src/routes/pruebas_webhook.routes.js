// routes/pruebas_webhook.routes.js — "Probar como cliente real" (panel).
//
// Estas rutas inyectan un mensaje por el webhook real y leen lo que contestó
// el bot. Además de la sesión exigen que la `id_configuracion` del body sea
// de la cuenta de quien llama (o que sea super administrador): sin eso,
// cualquier sesión podía escribirle al bot de otra cuenta como si fuera uno
// de sus clientes y leer la respuesta (2026-10-12).
const express = require('express');
const controller = require('../controllers/pruebas_webhook.controller');
const { protect } = require('../middlewares/auth.middleware');
const {
  requireConfiguracionPropietaria,
} = require('../middlewares/requireConfiguracionPropietaria.middleware');

const router = express.Router();
router.use(protect, requireConfiguracionPropietaria());
router.post('/enviar', controller.enviar);
router.post('/reiniciar', controller.reiniciar);
router.post('/mensajes', controller.mensajes);
router.post('/anuncios', controller.anuncios);

module.exports = router;
