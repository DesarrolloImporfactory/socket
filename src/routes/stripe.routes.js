// routes/planes.routes.js x
const express = require('express');
const router = express.Router();
const stripe_planesController = require('../controllers/stripe.controller');

const auth = require('../middlewares/auth.middleware');
const checkPlanActivo = require('../middlewares/checkPlanActivo.middleware');

router.use(auth.protect);



router.get('/stripe', stripe_planesController.listarPlanesStripe);
router.post('/crearSesionPago', stripe_planesController.crearSesionPago);
router.post('/facturasUsuario', stripe_planesController.obtenerFacturasUsuario);
router.post('/cancelarSuscripcion', checkPlanActivo, stripe_planesController.cancelarSuscripcion);
router.post('/obtenerSuscripcionActiva', stripe_planesController.obtenerSuscripcionActiva);
router.post('/crearSesionSetupPM', stripe_planesController.crearSesionSetupPM);
router.post('/portalAddPaymentMethod', stripe_planesController.portalAddPaymentMethod);
router.post('/portalGestionMetodos', stripe_planesController.portalGestionMetodos);
// 🔹 NUEVO: sesión de pago única para la conexión adicional y subusuario adicional
router.post('/crearSesionAddonConexion', checkPlanActivo, stripe_planesController.crearSesionAddonConexion);
router.post('/crearSesionAddonSubusuario', checkPlanActivo, stripe_planesController.crearSesionAddonSubusuario);
// NUEVO: free con Stripe (trial) y elegibilidad
router.post('/crearFreeTrial', stripe_planesController.crearFreeTrial);
router.post('/trialElegibilidad', stripe_planesController.trialElegibilidad);

router.post('/crearSesionFreeSetup', stripe_planesController.crearSesionFreeSetup);


// ========== NUEVAS RUTAS PARA PERSONALIZADO ==========
router.get('/addons', stripe_planesController.obtenerPreciosAddons);
router.post('/crearSesionPlanPersonalizado', stripe_planesController.crearSesionPlanPersonalizado);
router.post('/obtenerPlanPersonalizadoUsuario', stripe_planesController.obtenerPlanPersonalizadoUsuario);
// routes/stripe.routes.js
router.get('/miPlanPersonalizado', stripe_planesController.miPlanPersonalizado);











module.exports = router;
