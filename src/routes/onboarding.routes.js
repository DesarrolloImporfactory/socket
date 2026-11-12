// routes/onboarding.routes.js — avisos de arranque (agendar implementación).
const express = require('express');
const { protect } = require('../middlewares/auth.middleware');
const ctrl = require('../controllers/onboarding.controller');

const router = express.Router();
router.use(protect);

router.get('/implementacion', ctrl.implementacion);
router.post('/implementacion/mostrado', ctrl.mostrado);
router.post('/implementacion/respuesta', ctrl.respuesta);

// Oferta del complemento ImporKiller (modal al entrar, 2026-11-11).
router.get('/imporkiller', ctrl.imporkiller);
router.post('/imporkiller/mostrado', ctrl.imporkillerMostrado);
router.post('/imporkiller/no-mostrar', ctrl.imporkillerNoMostrar);

module.exports = router;
