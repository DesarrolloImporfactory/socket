const express = require('express');
const router = express.Router();
const validationMiddleware = require('../middlewares/validations.middleware');

/**
 * Productos
 */

// Crear el producto y el precio en Stripe
const stripeproController = require('../controllers/stripepro.controller');
router.post(
  '/crear_producto',
  validationMiddleware.validCrearProducto,
  stripeproController.crearProducto
);

// Editar producto: Solo se pueden editar nombre, descripción y datos de usuarios más no el precio
router.patch('/editar_producto', stripeproController.editarProducto);

// Eliminar producto
router.delete('/eliminar_producto', stripeproController.eliminarProducto);

router.put('/activar_producto', stripeproController.activarProducto);

router.get('/listar_productos', stripeproController.listarProductos);
/**
 * Precios
 */

// Este archiva, crea y predefine precios en Stripe
router.delete('/editar_precio', stripeproController.eliminarPrecio);
module.exports = router;
