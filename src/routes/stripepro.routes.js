const express = require('express');
const router = express.Router();
const validationMiddleware = require('../middlewares/validations.middleware');

const stripeproController = require('../controllers/stripepro.controller');
router.post(
  '/crear_producto',
  validationMiddleware.validCrearProducto,
  stripeproController.crearProducto
);

router.patch('/editar_producto', stripeproController.editarProducto);
router.delete('/editar_precio', stripeproController.eliminarPrecio);
module.exports = router;
