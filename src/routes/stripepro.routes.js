const express = require('express');
const router = express.Router();
const validationMiddleware = require('../middlewares/validations.middleware');

const stripeproController = require('../controllers/stripepro.controller');
router.post(
  '/crear_producto',
  validationMiddleware.validCrearProducto,
  stripeproController.crearProducto
);

module.exports = router;
