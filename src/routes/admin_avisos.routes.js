// Avisos por WhatsApp (plantillas del motor de reglas de Meta Ads).
// Solo super admin: decide qué plantillas siguen, se van o se agregan.
const express = require('express');
const router = express.Router();
const { protect } = require('../middlewares/auth.middleware');
const requireSuperAdmin = require('../middlewares/requireSuperAdmin.middleware');
const ctrl = require('../controllers/admin_avisos.controller');

router.use(protect);
router.use(requireSuperAdmin);

router.get('/listar', ctrl.listar);
router.post('/guardar', ctrl.guardar);
router.post('/eliminar', ctrl.eliminar);

module.exports = router;
