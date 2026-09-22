const usuarios_chat_centerController = require('../controllers/usuarios_chat_center.controller');

const restrictToRoles = require('../middlewares/restrictTo.middleware');
const { protect } = require('../middlewares/auth.middleware');
const limiteSub_usuarios = require('../middlewares/limiteSub_usuarios.middleware');

const express = require('express');

const router = express.Router();

/* === Preferencia del tour (sin protect, usando id_usuario en body) === */
router.post(
  '/tour-conexiones/get',
  usuarios_chat_centerController.getTourConexionesPrefByBody,
);
router.post(
  '/tour-conexiones/set',
  usuarios_chat_centerController.updateTourConexionesPrefByBody,
);

router.use(protect);

/* seccion administrar sub_usuarios  */
router.post('/listarUsuarios', usuarios_chat_centerController.listarUsuarios);

router.post(
  '/agregarUsuario',
  restrictToRoles('administrador'),
  limiteSub_usuarios,
  usuarios_chat_centerController.agregarUsuario,
);

router.post(
  '/actualizarUsuario',
  restrictToRoles('administrador'),
  usuarios_chat_centerController.actualizarUsuario,
);

router.delete(
  '/eliminarSubUsuario',
  restrictToRoles('administrador'),
  usuarios_chat_centerController.eliminarSubUsuario,
);
/* seccion administrar sub_usuarios  */

/* Importacion */
router.post(
  '/importacion_chat_center',
  usuarios_chat_centerController.importacion_chat_center,
);

/* Datos del dueño y su WhatsApp de avisos: solo el administrador de la
   cuenta, y siempre de SU cuenta. Antes tomaban id_usuario del body: un
   subusuario de ventas leía el correo del dueño en Mi Perfil y, cambiando el
   id, cualquier sesión podía leer o pisar el WhatsApp de otra cuenta. */
const cuentaDeSesion = (req, res, next) => {
  req.body = req.body || {};
  req.body.id_usuario = req.sessionUser.id_usuario;
  next();
};

router.post(
  '/actualizarWhatsappLead',
  restrictToRoles('administrador'),
  cuentaDeSesion,
  usuarios_chat_centerController.actualizarWhatsappLead,
);
// Datos del dueño de la cuenta (vista Mi Perfil)
router.post(
  '/infoPropietario',
  restrictToRoles('administrador'),
  cuentaDeSesion,
  usuarios_chat_centerController.infoPropietario,
);
// Bitácora de avisos enviados al dueño (vista Mi Perfil)
router.post(
  '/avisosEnviados',
  restrictToRoles('administrador'),
  cuentaDeSesion,
  usuarios_chat_centerController.avisosEnviados,
);

module.exports = router;
