const usuarios_chat_centerController = require('../controllers/usuarios_chat_center.controller');

const restrictToRoles = require('../middlewares/restrictTo.middleware');
const { protect } = require('../middlewares/auth.middleware');

const express = require('express');

const router = express.Router();

router.use(protect);

/* seccion administrar sub_usuarios  */
router.post(
  '/listarUsuarios',
  restrictToRoles('administrador'),
  usuarios_chat_centerController.listarUsuarios
);

router.post(
  '/agregarUsuario',
  restrictToRoles('administrador'),
  usuarios_chat_centerController.agregarUsuario
);

router.post(
  '/actualizarUsuario',
  restrictToRoles('administrador'),
  usuarios_chat_centerController.actualizarUsuario
);

router.delete(
  '/eliminarSubUsuario',
  restrictToRoles('administrador'),
  usuarios_chat_centerController.eliminarSubUsuario
);
/* seccion administrar sub_usuarios  */

/* Importacion */
router.post(
  '/importacion_chat_center',
  usuarios_chat_centerController.importacion_chat_center
);

module.exports = router;
