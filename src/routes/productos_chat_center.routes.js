const productos_chat_centerController = require('../controllers/productos_chat_center.controller');

const express = require('express');

const router = express.Router();

const { protect } = require('../middlewares/auth.middleware');
const checkPlanActivo = require('../middlewares/checkPlanActivo.middleware');
const { uploadProductoMedia } = require('../middlewares/uploadProductos');

router.use(protect);

router.post(
  '/listarProductos',
  checkPlanActivo,
  productos_chat_centerController.listarProductos
);

router.post(
  '/listarProductosImporsuit',
  checkPlanActivo,
  productos_chat_centerController.listarProductosImporsuit
);

router.post(
  '/agregarProducto',
  uploadProductoMedia,
  productos_chat_centerController.agregarProducto
);
router.post(
  '/actualizarProducto',
  uploadProductoMedia,
  productos_chat_centerController.actualizarProducto
);

router.delete(
  '/eliminarProducto',
  productos_chat_centerController.eliminarProducto
);

module.exports = router;
