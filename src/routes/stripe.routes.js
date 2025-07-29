// routes/planes.routes.js x
const express = require('express');
const router = express.Router();
const stripe_planesController = require('../controllers/stripe.controller');


router.get('/stripe', stripe_planesController.listarPlanesStripe);
router.post('/crearSesionPago', stripe_planesController.crearSesionPago);




module.exports = router;
