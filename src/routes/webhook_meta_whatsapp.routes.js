const webhook_meta_whatsappController = require('../controllers/webhook_meta_whatsapp.controller');

const express = require('express');

const router = express.Router();

router
  .route('/webhook_whatsapp')
  .get(webhook_meta_whatsappController.webhook_whatsapp)
  .post(webhook_meta_whatsappController.webhook_whatsapp);

module.exports = router;
