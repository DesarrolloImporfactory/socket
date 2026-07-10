const express = require('express');
const router = express.Router();

const auth = require('../middlewares/auth.middleware');
const ctrl = require('../controllers/dropi_stats.controller');

router.use(auth.protect);

// Semáforo de transportadoras por provincia/ciudad (para el panel de crear orden)
router.post('/semaforo_transportadoras', ctrl.semaforoTransportadoras);

// Ranking de tiendas por venta entregada (para la vista de conexiones)
router.post('/ranking_tiendas', ctrl.rankingTiendas);

// Vista analítica de transportadoras (histórico por ciudad/provincia + flete)
router.post('/transportadoras_historico', ctrl.transportadorasHistorico);
router.get('/zonas_disponibles', ctrl.zonasDisponibles);

module.exports = router;
