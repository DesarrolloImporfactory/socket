const express = require('express');
const rateLimit = require('express-rate-limit');
const ctrl = require('../controllers/public_api.controller');
const cfgCtrl = require('../controllers/public_config.controller');
const msjCtrl = require('../controllers/public_mensajes.controller');
const { apiKeyAuth, requireScope } = require('../middlewares/apiKey.middleware');

const router = express.Router();

/* Límite por llave (no por IP): el consumidor suele salir de una sola IP
   y no queremos que un tercero afecte a otro. */
const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => String(req.apiKey?.id || req.ip),
  message: {
    error: 'Demasiadas solicitudes. Máximo 60 por minuto por API key.',
  },
});

/* Los envíos gastan plata y reputación del número: tope propio, más corto
   que el general. 20/min alcanza para un CRM operando a mano; un masivo
   se hace con la pantalla de flujos, no por esta API. */
const limiterEnvios = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => String(req.apiKey?.id || req.ip),
  message: {
    error: 'Demasiados envíos. Máximo 20 por minuto por API key.',
  },
});

router.use(apiKeyAuth, limiter);

router.get('/ping', ctrl.ping);
router.get('/todo', ctrl.todo);
router.get('/resumen', ctrl.resumen);
router.get('/dropi', ctrl.dropiDashboard);
router.get('/ads', ctrl.adsDashboard);
router.get('/tablero', ctrl.tablero);
router.get('/ventas/respuestas', ctrl.ventasRespuestas);

/* ═══ Configuración editable por CRMs externos (Guardian y afines) ═══
   Lecturas con el scope histórico 'read'; escrituras SOLO con su scope
   explícito (la llave lo declara en api_keys.scopes — ver
   api_public_scopes_migration.sql). Todo acotado a la conexión de la llave
   y toda escritura auditada con el estado previo. */

// Bot / IA: prompts por columna del kanban
router.get('/bot', requireScope('read'), cfgCtrl.botLeer);
router.put('/bot/columnas/:id', requireScope('bot:write'), cfgCtrl.botEditarColumna);

// Flujos: etapas del tablero + secuencias de remarketing
router.get('/flujos', requireScope('read'), cfgCtrl.flujosLeer);
router.put(
  '/flujos/remarketing/:estado',
  requireScope('flujos:write'),
  cfgCtrl.flujosEditarRemarketing,
);

// Respuestas rápidas (atajos del chat)
router.get('/respuestas-rapidas', requireScope('read'), cfgCtrl.rapidasLeer);
router.post(
  '/respuestas-rapidas',
  requireScope('plantillas:write'),
  cfgCtrl.rapidasCrear,
);
router.put(
  '/respuestas-rapidas/:id',
  requireScope('plantillas:write'),
  cfgCtrl.rapidasEditar,
);
router.delete(
  '/respuestas-rapidas/:id',
  requireScope('plantillas:write'),
  cfgCtrl.rapidasEliminar,
);

/* ═══ Mensajería para CRMs externos ═══
   Lecturas con 'read'; envíos SOLO con 'mensajes:write'. Fuera de la
   ventana de 24h únicamente pasan plantillas aprobadas (regla de Meta). */

// Buscar la conversación por teléfono (encuentra el chat sin id previo)
router.get('/conversaciones', requireScope('read'), msjCtrl.conversacionBuscar);

// Mensajes de un chat; los audios traen `transcripcion` (si el bot la generó)
router.get(
  '/conversaciones/:id/mensajes',
  requireScope('read'),
  msjCtrl.conversacionMensajes,
);

// Plantilla aprobada a cualquier número (crea el chat si nunca escribió);
// soporta header con imagen y botón URL con variable
router.post(
  '/mensajes/plantilla',
  limiterEnvios,
  requireScope('mensajes:write'),
  msjCtrl.enviarPlantilla,
);

// Foto o video a un chat dentro de la ventana de 24h
router.post(
  '/mensajes/media',
  limiterEnvios,
  requireScope('mensajes:write'),
  msjCtrl.enviarMedia,
);

// Plantillas Meta de WhatsApp
router.get('/plantillas-meta', requireScope('read'), cfgCtrl.plantillasMetaLeer);
router.post(
  '/plantillas-meta',
  requireScope('plantillas:write'),
  cfgCtrl.plantillasMetaCrear,
);

module.exports = router;
