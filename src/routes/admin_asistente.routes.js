// Llaves del asistente flotante que paga la plataforma (OpenAI / Claude).
// Solo super admin: decide con qué llave responde y ve si alguna falla.
const express = require('express');
const router = express.Router();
const { protect } = require('../middlewares/auth.middleware');
const requireSuperAdmin = require('../middlewares/requireSuperAdmin.middleware');
const ctrl = require('../controllers/admin_asistente.controller');

router.use(protect);
router.use(requireSuperAdmin);

router.get('/config', ctrl.config);
router.get('/estado', ctrl.estado);
router.post('/guardar', ctrl.guardar);
router.post('/llave', ctrl.guardarLlave);
router.post('/eliminar_llave', ctrl.eliminarLlave);
router.post('/probar', ctrl.probar);

module.exports = router;
