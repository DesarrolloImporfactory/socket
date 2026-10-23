// routes/onboarding.routes.js — avisos de arranque (agendar implementación).
const express = require('express');
const { protect } = require('../middlewares/auth.middleware');
const ctrl = require('../controllers/onboarding.controller');

const router = express.Router();
router.use(protect);

router.get('/implementacion', ctrl.implementacion);
router.post('/implementacion/mostrado', ctrl.mostrado);
router.post('/implementacion/respuesta', ctrl.respuesta);

module.exports = router;
