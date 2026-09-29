const express = require('express');

const router = express.Router();

const { protect } = require('../middlewares/auth.middleware');
const incidencias = require('../controllers/incidencias_chat_center.controller');

router.use(protect);

router.get('/', incidencias.listar);
router.post('/', incidencias.crear);
// Casos (Escalar / Oportunidad Comercial): qué botones ve la conexión y alta.
router.get('/casos-config', incidencias.casosConfig);
router.post('/caso', incidencias.crearCaso);
// Seguimiento de casos (vista de Johan): acceso, listado, resolver, en espera.
router.get('/casos-acceso', incidencias.casosAcceso);
router.get('/casos', incidencias.listarCasos);
router.patch('/caso/:id/resolver', incidencias.resolverCaso);
router.patch('/caso/:id/espera', incidencias.esperaCaso);
router.delete('/:id', incidencias.eliminar);

module.exports = router;
