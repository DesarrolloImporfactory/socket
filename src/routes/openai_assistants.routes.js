const openai_assistantsController = require('../controllers/openai_assistants.controller');

const express = require('express');

const router = express.Router();

const { protect } = require('../middlewares/auth.middleware');

// routes/openai_assistants.routes.js
router.post(
  '/datosCliente',
  openai_assistantsController.datosCliente
);

router.post(
  '/mensaje_assistant',
  openai_assistantsController.mensaje_assistant
);

router.post(
  '/enviar_mensaje_gpt',
  openai_assistantsController.enviar_mensaje_gpt
);

router.post(
  '/info_asistentes',
  openai_assistantsController.info_asistentes
);

router.post(
  '/actualizar_api_key_openai',
  openai_assistantsController.actualizar_api_key_openai
);

router.post(
  '/actualizar_ia_logisctica',
  openai_assistantsController.actualizar_ia_logisctica
);

router.post(
  '/actualizar_ia_ventas',
  openai_assistantsController.actualizar_ia_ventas
);

module.exports = router;
