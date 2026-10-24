const express = require('express');
const router = express.Router();

const { teamToken } = require('../middlewares/teamToken.middleware');
const { protect } = require('../middlewares/auth.middleware');
const ctrl = require('../controllers/equipo.controller');

/* Rutas de Team para el rol «equipo» (utils/rolEquipo.js). Un usuario «equipo»
   solo puede llamar rutas de aquí: protect le niega el resto. */

// Servidor de Team → sesión de un usuario «equipo».
router.post('/sesion', teamToken, ctrl.sesion);

// Desde aquí, con la sesión de Team.
router.use(protect);
router.get('/yo', ctrl.yo);

module.exports = router;
