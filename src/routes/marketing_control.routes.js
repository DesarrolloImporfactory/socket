const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/marketing_control.controller');
const { protect } = require('../middlewares/auth.middleware');

router.get('/dashboard', ctrl.dashboard);
router.post('/impuesto-ads', protect, ctrl.guardarImpuestoAds);
router.get('/healthz', ctrl.healthz);

module.exports = router;
