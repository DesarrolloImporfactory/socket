const detalle_fact_cotController = require('../controllers/detalle_fact_cot.controller');

const express = require('express');

const router = express.Router();

const authMiddleware = require('../middlewares/auth.middleware');

// routes/detalle_fact_cot.routes.js
router.post(
  '/actualizarDetallePedido',
  detalle_fact_cotController.actualizarDetallePedido
);

module.exports = router;
