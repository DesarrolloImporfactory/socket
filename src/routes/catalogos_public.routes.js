const express = require('express');
const router = express.Router();

const catalogosPublicController = require('../controllers/catalogos_public.controller');

// Ruta pública (sin protect)
router.get('/catalogo/:slug', catalogosPublicController.verCatalogoPublico);

module.exports = router;
