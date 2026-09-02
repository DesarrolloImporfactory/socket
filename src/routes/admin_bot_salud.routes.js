const express = require('express');
const router = express.Router();
const { protect } = require('../middlewares/auth.middleware');
const requireSuperAdmin = require('../middlewares/requireSuperAdmin.middleware');
const ctrl = require('../controllers/admin_bot_salud.controller');

router.use(protect);
router.use(requireSuperAdmin);

router.get('/resumen', ctrl.resumen);
router.get('/cuentas', ctrl.cuentas);
router.get('/embudo', ctrl.embudo);
router.post('/recalcular', ctrl.recalcular);

module.exports = router;
