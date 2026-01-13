const cotizadorpro = require('../controllers/cotizadorpro.controller');

const express = require('express');

const router = express.Router();

router.get('/:id_chat', cotizadorpro.obtenerCotizaciones);

module.exports = router;