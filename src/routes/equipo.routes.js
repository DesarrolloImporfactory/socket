const express = require('express');
const router = express.Router();

const { teamToken } = require('../middlewares/teamToken.middleware');
const { protect } = require('../middlewares/auth.middleware');
const ctrl = require('../controllers/equipo.controller');

/* Rutas de Team para el rol «equipo» (utils/rolEquipo.js). Un usuario «equipo»
   solo puede llamar rutas de aquí: protect le niega el resto. */

// Servidor de Team → sesión de un usuario «equipo».
router.post('/sesion', teamToken, ctrl.sesion);

// Desde aquí, solo con la sesión de Team (protect ya la validó, la limitó a
// estas rutas y tapa los teléfonos). Con un token de login, ni el rol
// «equipo» ni nadie: los demás tienen sus pantallas de siempre.
router.use(protect, (req, res, next) =>
  req.sesionTeam === true
    ? next()
    : res.status(403).json({ status: 'fail', code: 'SOLO_EQUIPO', message: 'Esta sección es solo para el equipo de Team' }),
);
router.get('/yo', ctrl.yo);
router.get('/conexiones', ctrl.conexiones);
router.get('/chats', ctrl.chats);
router.get('/chats/:id_cliente/mensajes', ctrl.mensajes);
router.post('/chats/:id_cliente/mensajes', ctrl.enviarMensaje);
router.get('/chats/:id_cliente/carga', ctrl.carga);
router.get('/agenda', ctrl.agenda);

module.exports = router;
