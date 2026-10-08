const express = require('express');
const router = express.Router();

const auth = require('../middlewares/auth.middleware');
const ctrl = require('../controllers/notificaciones.controller');

// Notificaciones internas del usuario de la sesión (campana del encabezado).
router.use(auth.protect);

router.get('/', ctrl.listar);
router.get('/conteo', ctrl.conteo);
router.post('/leer-todas', ctrl.marcarTodasLeidas);
router.patch('/:id/leida', ctrl.marcarLeida);

module.exports = router;
