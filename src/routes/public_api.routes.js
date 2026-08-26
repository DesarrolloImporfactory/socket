const express = require('express');
const rateLimit = require('express-rate-limit');
const ctrl = require('../controllers/public_api.controller');
const cfgCtrl = require('../controllers/public_config.controller');
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

// Plantillas Meta de WhatsApp
router.get('/plantillas-meta', requireScope('read'), cfgCtrl.plantillasMetaLeer);
router.post(
  '/plantillas-meta',
  requireScope('plantillas:write'),
  cfgCtrl.plantillasMetaCrear,
);

module.exports = router;
