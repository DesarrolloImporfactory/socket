const express = require('express');
const ctrl = require('../controllers/public_api.controller');
const auth = require('../middlewares/auth.middleware');

const router = express.Router();

// Gestión de llaves de la API pública: sesión del panel + dueño de la config
router.use(auth.protect);

router.get('/', auth.protectConfigOwner, ctrl.listarApiKeys);
router.post('/', auth.protectConfigOwner, ctrl.crearApiKey);
router.post('/revocar', auth.protectConfigOwner, ctrl.revocarApiKey);

// Actividad de los CRMs conectados: qué cambiaron y deshacerlo. SOLO el
// dueño desde su sesión — la llave API jamás puede revertir.
router.get('/auditoria', auth.protectConfigOwner, ctrl.listarAuditoria);
router.post(
  '/auditoria/revertir',
  auth.protectConfigOwner,
  ctrl.revertirAuditoria,
);

module.exports = router;
