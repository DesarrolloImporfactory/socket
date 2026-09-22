const express = require('express');
const router = express.Router();

const auth = require('../middlewares/auth.middleware');
const excluirRoles = require('../middlewares/excluirRoles.middleware');
const ctrl = require('../controllers/dropi_stats.controller');

// Ranking público de Ecuador para la home de Imporsuit
router.get('/ranking_publico_ec', ctrl.rankingPublicoEc);

router.use(auth.protect);

// Semáforo de transportadoras por provincia/ciudad (para el panel de crear orden)
router.post('/semaforo_transportadoras', ctrl.semaforoTransportadoras);

// Ranking de tiendas por venta entregada (para la vista de conexiones). El
// asesor de ventas no lo ve: expone el total vendido de la cuenta y su
// posición frente a las demás tiendas.
router.post('/ranking_tiendas', excluirRoles('ventas'), ctrl.rankingTiendas);

// Vista analítica de transportadoras (histórico por ciudad/provincia + flete)
router.post('/transportadoras_historico', ctrl.transportadorasHistorico);
router.get('/zonas_disponibles', ctrl.zonasDisponibles);

module.exports = router;
