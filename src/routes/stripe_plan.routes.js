const express = require('express');
const stripeController = require('../controllers/stripe.controller');
const { protect } = require('../middlewares/auth.middleware');

const router = express.Router();

router.use(protect);

// Checkout Subscription (trial lo decide backend)
router.post('/crearSesionPago', stripeController.crearSesionPago);

//  Suscripción activa (para MiPlan.jsx)
router.post(
  '/obtenerSuscripcionActiva',
  stripeController.obtenerSuscripcionActiva,
);

//  Facturas (para MiPlan.jsx)
router.post('/facturasUsuario', stripeController.facturasUsuario);

//  Customer Portal (cancelar, métodos, facturas, etc.)
router.post('/portalCliente', stripeController.portalCliente);

//  Cancelar suscripción (si quiere mantener botón directo)
router.post('/cancelarSuscripcion', stripeController.cancelarSuscripcion);

// (Opcional) Portales específicos (si ya los usa)
router.post('/portalGestionMetodos', stripeController.portalGestionMetodos);
router.post('/portalAddPaymentMethod', stripeController.portalAddPaymentMethod);

module.exports = router;
