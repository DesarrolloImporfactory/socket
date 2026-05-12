const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/marketing_control.controller');

router.get('/dashboard', ctrl.dashboard);
router.get('/healthz', ctrl.healthz);

module.exports = router;
