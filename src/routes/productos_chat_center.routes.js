const productos_chat_centerController = require('../controllers/productos_chat_center.controller');

const express = require('express');

const router = express.Router();

const { protect } = require('../middlewares/auth.middleware');
const checkPlanActivo = require('../middlewares/checkPlanActivo.middleware');
const {
  uploadProductoMedia,
  uploadImagenIA,
} = require('../middlewares/uploadProductos');

const { uploadExcel } = require('../middlewares/uploadExcel');

router.use(protect);

router.post(
  '/listarProductos',
  checkPlanActivo,
  productos_chat_centerController.listarProductos,
);

router.post(
  '/listarProductosImporsuit',
  checkPlanActivo,
  productos_chat_centerController.listarProductosImporsuit,
);

router.post(
  '/agregarProducto',
  uploadProductoMedia,
  productos_chat_centerController.agregarProducto,
);
router.post(
  '/actualizarProducto',
  uploadProductoMedia,
  productos_chat_centerController.actualizarProducto,
);

router.delete(
  '/eliminarProducto',
  productos_chat_centerController.eliminarProducto,
);

/* Redacta la descripción con la API key de OpenAI del propio negocio.
   Va con multer aunque no guarde nada: la foto llega dentro de un multipart
   (todavía no está subida cuando el producto se está creando) y sin multer
   req.body llegaría vacío. */
router.post(
  '/generarDescripcionIA',
  checkPlanActivo,
  uploadImagenIA,
  productos_chat_centerController.generarDescripcionIA,
);

// Ruta nueva para carga masiva
router.post(
  '/cargaMasivaProductos',
  uploadExcel,
  productos_chat_centerController.cargaMasivaProductos,
);

router.post(
  '/listarProductosDropi',
  productos_chat_centerController.listarProductosDropi,
);

router.post(
  '/importarProductoDropi',
  productos_chat_centerController.importarProductoDropi,
);

module.exports = router;
