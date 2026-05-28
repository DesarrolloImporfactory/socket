const express = require('express');
const router = express.Router();
const { protect } = require('../middlewares/auth.middleware');
const requireSuperAdmin = require('../middlewares/requireSuperAdmin.middleware');
const ctrl = require('../controllers/admin_dashboard.controller');

router.use(protect);
router.use(requireSuperAdmin);

router.get('/resumen', ctrl.resumen);
router.get('/serie', ctrl.serie);
router.get('/cancelaciones_mes', ctrl.cancelacionesMes);
router.get('/desglose_planes', ctrl.desglosePlanes);
router.post('/snapshot_now', ctrl.snapshotAhora);
router.get('/clientes_por_categoria', ctrl.clientesPorCategoria);

module.exports = router;
