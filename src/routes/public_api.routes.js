const express = require('express');
const rateLimit = require('express-rate-limit');
const ctrl = require('../controllers/public_api.controller');
const { apiKeyAuth } = require('../middlewares/apiKey.middleware');

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

module.exports = router;
