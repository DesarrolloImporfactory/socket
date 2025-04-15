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

module.exports = router;
