const usuarios_chat_centerController = require('../controllers/usuarios_chat_center.controller');

const express = require('express');

const router = express.Router();

router.post(
  '/importacion_chat_center',
  usuarios_chat_centerController.importacion_chat_center
);

module.exports = router;
