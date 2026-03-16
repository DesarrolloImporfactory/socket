const express = require('express');
const stripeController = require('../controllers/stripe.controller');
const { protect } = require('../middlewares/auth.middleware');

const router = express.Router();

router.use(protect);

// Checkout Subscription
router.post('/crearSesionPago', stripeController.crearSesionPago);

// Cambiar Plan (upgrade, downgrade, mismo precio)
router.post('/cambiarPlan', stripeController.cambiarPlan);

// Suscripción activa (para MiPlan.jsx y PlanesView.jsx)
router.post(
  '/obtenerSuscripcionActiva',
  stripeController.obtenerSuscripcionActiva,
);

// Facturas
router.post('/facturasUsuario', stripeController.facturasUsuario);

// Customer Portal
router.post('/portalCliente', stripeController.portalCliente);

// Cancelar suscripción
router.post('/cancelarSuscripcion', stripeController.cancelarSuscripcion);

// Portales específicos
router.post('/portalGestionMetodos', stripeController.portalGestionMetodos);
router.post('/portalAddPaymentMethod', stripeController.portalAddPaymentMethod);

// ═══════════════════════════════════════════════════════
// NUEVOS: Trial por uso (Insta Landing)
// ═══════════════════════════════════════════════════════

// Activar prueba gratuita IL (10 imágenes, sin tarjeta)
router.post('/activarTrialUsage', stripeController.activarTrialUsage);

// Verificar/incrementar uso del trial IL
// Llamar desde el endpoint de generación de imágenes
router.post('/verificarTrialUsage', stripeController.verificarTrialUsage);

module.exports = router;
