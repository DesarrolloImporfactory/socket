// routes/consumo_ia.routes.js — consumo del asistente (tokens / costo por día).
const express = require('express');
const controller = require('../controllers/consumo_ia.controller');
const { protect } = require('../middlewares/auth.middleware');

const router = express.Router();
router.use(protect);
router.post('/resumen', controller.resumen);

module.exports = router;
