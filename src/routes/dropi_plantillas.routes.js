const router = require('express').Router();
const ctrl = require('../controllers/dropi_plantillas.controller');

router.post('/obtener', ctrl.obtener);
router.post('/guardar', ctrl.guardar);

// Respondedor logístico sin IA (interruptor + rango manual de demora)
router.post('/respondedor/obtener', ctrl.obtenerRespondedor);
router.post('/respondedor/guardar', ctrl.guardarRespondedor);

module.exports = router;
