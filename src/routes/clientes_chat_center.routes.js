const clientes_chat_centerController = require('../controllers/clientes_chat_center.controller');

const express = require('express');

const router = express.Router();

const { protect } = require('../middlewares/auth.middleware');

// routes/clientes_chat_center.routes.js
router.post(
  '/actualizar_cerrado',
  clientes_chat_centerController.actualizar_cerrado
);

router.post(
  '/actualizar_bot_openia',
  clientes_chat_centerController.actualizar_bot_openia
);

module.exports = router;
