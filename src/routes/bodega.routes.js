const bodegaController = require('../controllers/bodega.controller');

const express = require('express');

const router = express.Router();

const authMiddleware = require('../middlewares/auth.middleware');
/* router.use(authMiddleware.protect); */

// routes/bodega.routes.js
router.post(
  '/obtener_nombre_bodega',
  bodegaController.obtener_nombre_bodega
);

module.exports = router;
