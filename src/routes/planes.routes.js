const planesController = require('../controllers/planes.controller');

const express = require('express');
const router = express.Router();

const { protect } = require('../middlewares/auth.middleware');

router.use(protect);

router.post('/seleccionarPlan', planesController.seleccionarPlan);

router.get('/listarPlanes', planesController.listarPlanes);

module.exports = router;
