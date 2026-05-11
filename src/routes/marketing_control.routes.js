const express = require('express');
const router = express.Router();
const { protect } = require('../middlewares/auth.middleware');
const ctrl = require('../controllers/marketing_control.controller');

// Health (sin protect — útil para verificar config sin login)
router.get('/healthz', ctrl.healthz);

// Endpoints protegidos (requieren JWT del chatcenter)
router.use(protect);

router.get('/funnel', ctrl.funnel);
router.get('/top-ads', ctrl.topAds);

module.exports = router;
