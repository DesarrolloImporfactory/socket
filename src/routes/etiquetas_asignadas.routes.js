const EtiquetasAsignadas = require('../controllers/etiquetas_asignadas.controller');

const express = require('express');
const router = express.Router();

const authMiddleware = require('../middlewares/auth.middleware');
router.use(authMiddleware.protect);

router.post('/obtenerEtiquetasAsignadas', EtiquetasAsignadas.obtenerEtiquetasAsignadas);
module.exports = router;
