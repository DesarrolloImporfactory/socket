const cotizadorpro = require('../controllers/cotizadorpro.controller');

const express = require('express');

const router = express.Router();

router.get('/:id_chat', cotizadorpro.obtenerCotizaciones);

router.post('/enviarCotizacion', cotizadorpro.enviarCotizacion);

router.post('/enviarFechaEstimada', cotizadorpro.enviarFechaEstimada);

router.post('/enviarVideoCotizacion', cotizadorpro.enviarVideoCotizacion);
router.post('/reenviarCotizacion', cotizadorpro.reenviarCotizacion);

router.post('/enviarCarga', cotizadorpro.enviarCarga);

router.post('/crm/registrarMensaje', cotizadorpro.registrarMensajeCRM);

module.exports = router;