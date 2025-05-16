const clientes_chat_centerController = require('../controllers/clientes_chat_center.controller');

const express = require('express');

const router = express.Router();

const authMiddleware = require('../middlewares/auth.middleware');
/* router.use(authMiddleware.protect); */

// routes/clientes_chat_center.routes.js
router.post(
  '/actualizar_cerrado',
  clientes_chat_centerController.actualizar_cerrado
);

router.post(
  '/actualizar_bot_openia',
  clientes_chat_centerController.actualizar_bot_openia
);

router.post(
  '/agregarNumeroChat',
  clientes_chat_centerController.agregarNumeroChat
);

router.post(
  '/buscar_id_recibe',
  clientes_chat_centerController.buscar_id_recibe
);

router.post(
  '/agregarMensajeEnviado',
  clientes_chat_centerController.agregarMensajeEnviado
);

module.exports = router;
