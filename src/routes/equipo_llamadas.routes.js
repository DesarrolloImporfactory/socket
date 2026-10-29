const express = require('express');
const router = express.Router();

const { protect } = require('../middlewares/auth.middleware');
const ctrl = require('../controllers/equipo_llamadas.controller');

/* Llamar al cliente desde Team (rol «equipo»). Ver
   controllers/equipo_llamadas.controller.js. Montado en
   /api/v1/equipo/llamadas, antes que equipo.routes: misma puerta (solo la
   sesión de Team, que además tapa los teléfonos de toda respuesta). */
router.use(protect, (req, res, next) =>
  req.sesionTeam === true
    ? next()
    : res.status(403).json({ status: 'fail', code: 'SOLO_EQUIPO', message: 'Esta sección es solo para el equipo de Team' }),
);

router.get('/yo', ctrl.yo);
router.get('/chats/:id_cliente/disponible', ctrl.disponible);
router.post('/chats/:id_cliente/permiso', ctrl.pedirPermiso);
router.post('/chats/:id_cliente/whatsapp', ctrl.llamarWhatsapp);
router.get('/whatsapp/:id_llamada', ctrl.estadoWhatsapp);
router.post('/whatsapp/:id_llamada/colgar', ctrl.colgarWhatsapp);
router.get('/telefono/widget', ctrl.widgetTelefono);
router.post('/chats/:id_cliente/telefono', ctrl.llamarTelefono);
router.get('/telefono/:id_llamada', ctrl.estadoTelefono);

module.exports = router;
