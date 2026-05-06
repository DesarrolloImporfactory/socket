const express = require('express');
const comunidadController = require('../controllers/comunidad.controller');
const router = express.Router();

router.get('/', comunidadController.listarComunidades);

module.exports = router;
