const express = require('express');
const router = express.Router();
const { protect } = require('../middlewares/auth.middleware');
const requireSuperAdmin = require('../middlewares/requireSuperAdmin.middleware');
const requireFinanzasDashboard = require('../middlewares/requireFinanzasDashboard.middleware');
const ctrl = require('../controllers/admin_dashboard.controller');

router.use(protect);

// Lectura: super administrador o finanzas (lista en requireFinanzasDashboard)
router.get('/resumen', requireFinanzasDashboard, ctrl.resumen);
router.get('/serie', requireFinanzasDashboard, ctrl.serie);
router.get('/cancelaciones_mes', requireFinanzasDashboard, ctrl.cancelacionesMes);
router.get('/desglose_planes', requireFinanzasDashboard, ctrl.desglosePlanes);
router.get('/clientes_por_categoria', requireFinanzasDashboard, ctrl.clientesPorCategoria);
router.get('/cobros', requireFinanzasDashboard, ctrl.cobros);

// Recalcular guarda un snapshot: solo super administrador
router.post('/snapshot_now', requireSuperAdmin, ctrl.snapshotAhora);

module.exports = router;
