const categorias_chat_centerController = require('../controllers/categorias_chat_center.controller');

const express = require('express');

const router = express.Router();

const { protect } = require('../middlewares/auth.middleware');
const checkPlanActivo = require('../middlewares/checkPlanActivo.middleware');

router.use(protect);

router.post(
  '/listarCategorias',
  checkPlanActivo,
  categorias_chat_centerController.listarCategorias
);

router.post(
  '/agregarCategoria',
  categorias_chat_centerController.agregarCategoria
);

router.post(
  '/actualizarCategoria',
  categorias_chat_centerController.actualizarCategoria
);

router.delete(
  '/eliminarCategoria',
  categorias_chat_centerController.eliminarCategoria
);

module.exports = router;
