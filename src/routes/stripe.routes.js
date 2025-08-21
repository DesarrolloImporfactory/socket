// routes/planes.routes.js x
const express = require('express');
const router = express.Router();
const stripe_planesController = require('../controllers/stripe.controller');


router.get('/stripe', stripe_planesController.listarPlanesStripe);
router.post('/crearSesionPago', stripe_planesController.crearSesionPago);
router.post('/facturasUsuario', stripe_planesController.obtenerFacturasUsuario);
router.post('/cancelarSuscripcion', stripe_planesController.cancelarSuscripcion);
router.post('/obtenerSuscripcionActiva', stripe_planesController.obtenerSuscripcionActiva);
router.post('/crearSesionSetupPM', stripe_planesController.crearSesionSetupPM);
router.post('/portalAddPaymentMethod', stripe_planesController.portalAddPaymentMethod);
router.post('/portalGestionMetodos', stripe_planesController.portalGestionMetodos);
// 🔹 NUEVO: sesión de pago única para la conexión adicional y subusuario adicional
router.post('/crearSesionAddonConexion', stripe_planesController.crearSesionAddonConexion);
router.post('/crearSesionAddonSubusuario', stripe_planesController.crearSesionAddonSubusuario);




module.exports = router;
