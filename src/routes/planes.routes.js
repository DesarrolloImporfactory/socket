const express = require('express');
const planesController = require('../controllers/planes.controller');
const { protect } = require('../middlewares/auth.middleware');

const router = express.Router();
router.use(protect);

router.get('/listarPlanes', planesController.obtenerPlanes);

router.post('/seleccionarPlan', planesController.seleccionarPlan);

module.exports = router;
