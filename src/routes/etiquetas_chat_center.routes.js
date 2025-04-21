const etiquetasController = require('../controllers/etiquetas_chat_center.controller');

const express = require('express');
const router = express.Router();

const { protect } = require('../middlewares/auth.middleware');
// router.use(protect);

router.post('/agregarEtiqueta', etiquetasController.AgregarEtiqueta);

module.exports = router;
