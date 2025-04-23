const etiquetasController = require('../controllers/etiquetas_chat_center.controller');

const express = require('express');
const router = express.Router();

const authMiddleware = require('../middlewares/auth.middleware');
router.use(authMiddleware.protect);

router.post('/agregarEtiqueta', etiquetasController.agregarEtiqueta);

router.delete('/eliminarEtiqueta/:id', etiquetasController.eliminarEtiqueta);

router.post('/toggleAsignacionEtiqueta', etiquetasController.toggleAsignacionEtiqueta);

router.post('/obtenerEtiquetas', etiquetasController.obtenerEtiquetas);
module.exports = router;
