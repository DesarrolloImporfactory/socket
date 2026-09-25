const express = require('express');
const router = express.Router();

const auth = require('../middlewares/auth.middleware');
const ctrl = require('../controllers/enlaces_pago.controller');

router.use(auth.protect);

// Crear (y enviar por WhatsApp) un enlace de pago para un contacto del chat.
router.post('/', auth.protectConfigOwner, ctrl.crear);

// Historial de toda la cuenta (Integraciones → Stripe → Cobros). Va antes de
// las rutas con :id para que "historial" no se lea como un id.
router.get('/historial', auth.protectConfigOwner, ctrl.historial);

// Enlaces de un contacto (refresca los pendientes antes de responder).
router.get('/', auth.protectConfigOwner, ctrl.listar);

// Las rutas con :id validan la propiedad dentro del controlador.
router.post('/:id/refrescar', ctrl.refrescar);
router.post('/:id/anular', ctrl.anular);

module.exports = router;
