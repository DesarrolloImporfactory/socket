const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/encuestas_publico.controller');

// SIN protect — son endpoints públicos para el cliente final
router.get('/publica/:idEncuesta', ctrl.obtenerEncuestaPublica);
router.post('/publica/:idEncuesta/responder', ctrl.responderEncuestaPublica);

module.exports = router;
