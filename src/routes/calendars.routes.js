const express = require('express');
const router = express.Router();

const auth = require('../middlewares/auth.middleware');
const checkPlanActivo = require('../middlewares/checkPlanActivo.middleware');
const { requiereAccesoCalendario } = require('../utils/accesoCalendario');

const ctrl = require('../controllers/calendars.controller');

//Protecciones globales del router - aplicando a todas las rutas
router.use(auth.protect);
router.use(checkPlanActivo);
// Qué planes tienen agenda se decide en utils/accesoCalendario (hoy: todos).
router.use(requiereAccesoCalendario);

router.get('/', ctrl.list);
router.post('/', ctrl.create);
router.post('/ensure', ctrl.ensure);

module.exports = router;
