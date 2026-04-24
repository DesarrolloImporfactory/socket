const router = require('express').Router();
const ctrl = require('../controllers/dropi_plantillas.controller');

router.post('/obtener', ctrl.obtener);
router.post('/guardar', ctrl.guardar);

module.exports = router;
