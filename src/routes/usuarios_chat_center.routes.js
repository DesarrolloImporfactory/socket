const usuarios_chat_centerController = require('../controllers/usuarios_chat_center.controller');

const restrictToRoles = require('../middlewares/restrictTo.middleware');
const { protect } = require('../middlewares/auth.middleware');
const limiteSub_usuarios = require('../middlewares/limiteSub_usuarios.middleware');

const express = require('express');

const router = express.Router();




/* === Preferencia del tour (sin protect, usando id_usuario en body) === */
router.post('/tour-conexiones/get', usuarios_chat_centerController.getTourConexionesPrefByBody);
router.post('/tour-conexiones/set', usuarios_chat_centerController.updateTourConexionesPrefByBody);


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
  limiteSub_usuarios,
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
