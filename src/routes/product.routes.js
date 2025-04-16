const productosController = require('../controllers/products.controller');
const express = require('express');

const router = express.Router();

const authMiddleware = require('../middlewares/auth.middleware');
router.use(authMiddleware.protect);

router.post('/agregarProducto', productosController.agregarProducto);

router.route('/:bodega').post(productosController.findAllAditionalProducts);

module.exports = router;
