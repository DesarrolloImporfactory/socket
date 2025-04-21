const etiquetasController = require('../controllers/etiquetas_chat_center.controller');

const express = require('express');
const router = express.Router();

// const authMiddleware = require('../middlewares/auth.middleware');
// router.use(authMiddleware.protect);

router.post('/agregarEtiqueta', etiquetasController.AgregarEtiqueta);

router.delete('/eliminarEtiqueta/:id', etiquetasController.EliminarEtiqueta);

router.post('/toggleAsignacionEtiqueta', etiquetasController.ToggleAsignacionEtiqueta);
module.exports = router;
