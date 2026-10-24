const express = require('express');
const router = express.Router();

const { teamToken } = require('../middlewares/teamToken.middleware');
const { protect } = require('../middlewares/auth.middleware');
const ctrl = require('../controllers/equipo.controller');
const { esEquipo } = require('../utils/rolEquipo');

/* Rutas de Team para el rol «equipo» (utils/rolEquipo.js). Un usuario «equipo»
   solo puede llamar rutas de aquí: protect le niega el resto. */

// Servidor de Team → sesión de un usuario «equipo».
router.post('/sesion', teamToken, ctrl.sesion);

// Desde aquí, con la sesión de Team y solo para el rol «equipo»: los demás
// roles tienen sus pantallas de siempre.
router.use(protect, (req, res, next) =>
  esEquipo(req.sessionUser)
    ? next()
    : res.status(403).json({ status: 'fail', code: 'SOLO_EQUIPO', message: 'Esta sección es solo para el equipo de Team' }),
);
router.get('/yo', ctrl.yo);
router.get('/conexiones', ctrl.conexiones);
router.get('/chats', ctrl.chats);
router.get('/chats/:id_cliente/mensajes', ctrl.mensajes);
router.get('/chats/:id_cliente/carga', ctrl.carga);
router.get('/agenda', ctrl.agenda);

module.exports = router;
