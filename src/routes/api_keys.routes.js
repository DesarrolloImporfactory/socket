const express = require('express');
const ctrl = require('../controllers/public_api.controller');
const auth = require('../middlewares/auth.middleware');

const router = express.Router();

// Gestión de llaves de la API pública: sesión del panel + dueño de la config
router.use(auth.protect);

router.get('/', auth.protectConfigOwner, ctrl.listarApiKeys);
router.post('/', auth.protectConfigOwner, ctrl.crearApiKey);
router.post('/revocar', auth.protectConfigOwner, ctrl.revocarApiKey);

module.exports = router;
