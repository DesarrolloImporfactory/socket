const openai_assistantsController = require('../controllers/openai_assistants.controller');

const express = require('express');

const router = express.Router();

const { protect } = require('../middlewares/auth.middleware');
const {
  requireImporiaSecret,
} = require('../middlewares/imporiaSecret.middleware');

// routes/openai_assistants.routes.js
router.post('/datosCliente', openai_assistantsController.datosCliente);

router.post(
  '/mensaje_assistant',
  openai_assistantsController.mensaje_assistant,
);

/* Motor de ImporIA. Va con requireImporiaSecret —y no con protect— porque
   quien llama es el PHP de imporsuit-pro de servidor a servidor, no un
   navegador con sesión de ChatCenter. Estuvo abierto sin auth hasta el
   2026-09-02, corriendo contra la API key de Imporfactory. */
router.post(
  '/enviar_mensaje_gpt',
  requireImporiaSecret,
  openai_assistantsController.enviar_mensaje_gpt,
);

router.post('/info_asistentes', openai_assistantsController.info_asistentes);

router.post(
  '/actualizar_api_key_openai',
  openai_assistantsController.actualizar_api_key_openai,
);

// Elimina la API Key y suspende (soft delete) los asistentes de la config
router.post(
  '/eliminar_api_key_openai',
  openai_assistantsController.eliminar_api_key_openai,
);

router.post(
  '/actualizar_ia_logisctica',
  openai_assistantsController.actualizar_ia_logisctica,
);

router.post(
  '/actualizar_ia_ventas',
  openai_assistantsController.actualizar_ia_ventas,
);

// ✅ NUEVA RUTA: sincroniza plantillas desde sus assistants maestros
router.post(
  '/sync_templates_from_oia_asistentes',
  openai_assistantsController.sync_templates_from_oia_asistentes,
);

router.post(
  '/configurar_remarketing',
  openai_assistantsController.configurar_remarketing,
);

router.post(
  '/obtener_remarketing',
  openai_assistantsController.obtener_remarketing,
);

router.post(
  '/desactivar_remarketing',
  openai_assistantsController.desactivar_remarketing,
);

router.post('/eliminar_thread', openai_assistantsController.eliminar_thread);

router.get('/openai_status', openai_assistantsController.openai_status);

/* "Ya pagué": comprueba contra OpenAI y reactiva si de verdad hay saldo.
   Va con protect —a diferencia del resto de este router— porque dispara una
   llamada facturable contra la cuenta del cliente: sin sesión, cualquiera
   podría hacerle gastar saldo repitiendo la petición. */
router.post(
  '/openai_reintentar',
  protect,
  openai_assistantsController.openai_reintentar,
);

module.exports = router;
