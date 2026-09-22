const express = require('express');
const stripeController = require('../controllers/stripe.controller');
const { protect } = require('../middlewares/auth.middleware');
const restrictToRoles = require('../middlewares/restrictTo.middleware');

const router = express.Router();

router.use(protect);

/* Facturación de la cuenta: solo el administrador. Un subusuario de ventas
   no cambia ni cancela la suscripción ni entra al portal de cobros.
   crearSesionPago y portalAddPaymentMethod quedan abiertos porque los
   dispara el bloqueo de plan (CARD_CAPTURE_REQUIRED) desde cualquier sesión. */
const soloAdministrador = restrictToRoles('administrador');

// Checkout Subscription
router.post('/crearSesionPago', stripeController.crearSesionPago);

// Cambiar Plan (upgrade, downgrade, mismo precio)
router.post('/cambiarPlan', soloAdministrador, stripeController.cambiarPlan);

// Suscripción activa (para MiPlan.jsx y PlanesView.jsx)
router.post(
  '/obtenerSuscripcionActiva',
  stripeController.obtenerSuscripcionActiva,
);

// Facturas
router.post(
  '/facturasUsuario',
  soloAdministrador,
  stripeController.facturasUsuario,
);

// Customer Portal
router.post(
  '/portalCliente',
  soloAdministrador,
  stripeController.portalCliente,
);

// Cancelar suscripción
router.post(
  '/cancelarSuscripcion',
  soloAdministrador,
  stripeController.cancelarSuscripcion,
);

// Portales específicos
router.post(
  '/portalGestionMetodos',
  soloAdministrador,
  stripeController.portalGestionMetodos,
);
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
// Captura de tarjeta Plan 21 (Method Ecommerce)
router.post('/capturarTarjetaPlan21', stripeController.capturarTarjetaPlan21);

router.post('/comprarAddon', stripeController.comprarAddon);

router.post('/cancelarDowngrade', stripeController.cancelarDowngrade);

module.exports = router;
