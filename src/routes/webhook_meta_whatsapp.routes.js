const webhook_meta_whatsappController = require('../controllers/webhook_meta_whatsapp.controller');
const webhook_meta_whatsapp_masivoController = require('../controllers/webhook_meta_whatsapp_masivo.controller');

const express = require('express');

const router = express.Router();

router
  .route('/webhook_whatsapp')
  .get(webhook_meta_whatsappController.webhook_whatsapp)
  .post(webhook_meta_whatsappController.webhook_whatsapp);

router.post(
  '/webhook_whatsapp_prueba_masiva',
  webhook_meta_whatsapp_masivoController.prueba_masiva
);

// Nueva ruta para pruebas concurrentes
router.post(
  '/webhook_whatsapp_prueba_concurrente',
  webhook_meta_whatsapp_masivoController.prueba_masiva_concurrente
);

// Nueva ruta para verificar endpoint
router.get(
  '/webhook_whatsapp_verificar',
  webhook_meta_whatsapp_masivoController.verificar_endpoint
);

module.exports = router;
