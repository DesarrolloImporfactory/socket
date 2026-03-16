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
// Trial por uso (Insta Landing)
// ═══════════════════════════════════════════════════════
router.post('/activarTrialUsage', stripeController.activarTrialUsage);
router.post('/verificarTrialUsage', stripeController.verificarTrialUsage);

// ═══════════════════════════════════════════════════════
// Códigos Promocionales — Cliente
// ═══════════════════════════════════════════════════════
router.post('/validarCodigoPromo', stripeController.validarCodigoPromo);
router.post('/canjearCodigoPromo', stripeController.canjearCodigoPromo);

// ═══════════════════════════════════════════════════════
// Códigos Promocionales — CRUD Super Admin
// Proteger con middleware de admin en tu implementación
// ═══════════════════════════════════════════════════════
router.get('/codigos-promo', stripeController.listarCodigosPromo);
router.post('/codigos-promo', stripeController.crearCodigoPromo);
router.put('/codigos-promo/:id_codigo', stripeController.actualizarCodigoPromo);
router.delete(
  '/codigos-promo/:id_codigo',
  stripeController.eliminarCodigoPromo,
);
router.get(
  '/codigos-promo/:id_codigo/canjes',
  stripeController.listarCanjesCodigo,
);

module.exports = router;
