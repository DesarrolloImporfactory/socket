const planesController = require('../controllers/planes.controller');

const express = require('express');
const router = express.Router();

const authMiddleware = require('../middlewares/auth.middleware');

router.post('/seleccionarPlan', planesController.seleccionarPlan);

module.exports = router;
