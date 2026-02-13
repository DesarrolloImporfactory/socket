const cotizadorpro = require('../controllers/cotizadorpro.controller');

const express = require('express');

const router = express.Router();

router.get('/:id_chat', cotizadorpro.obtenerCotizaciones);

router.post('/enviarCotizacion', cotizadorpro.enviarCotizacion);

router.post('/enviarVideoCotizacion', cotizadorpro.enviarVideoCotizacion);

module.exports = router;