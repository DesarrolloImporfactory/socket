// routes/pruebas_webhook.routes.js — "Probar como cliente real" (panel).
const express = require('express');
const controller = require('../controllers/pruebas_webhook.controller');
const { protect } = require('../middlewares/auth.middleware');

const router = express.Router();
router.use(protect);
router.post('/enviar', controller.enviar);
router.post('/reiniciar', controller.reiniciar);
router.post('/mensajes', controller.mensajes);
router.post('/anuncios', controller.anuncios);

module.exports = router;
