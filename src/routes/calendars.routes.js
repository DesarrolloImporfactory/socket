const express = require('express');
const router = express.Router();

const auth = require('../middlewares/auth.middleware');
const checkPlanActivo = require('../middlewares/checkPlanActivo.middleware');
const restrictToPlanes = require('../middlewares/restrictToPlanes.middleware');

const ctrl = require('../controllers/calendars.controller');

//Protecciones globales del router - aplicando a todas las rutas
router.use(auth.protect);
router.use(checkPlanActivo);
router.use(restrictToPlanes([1, 3, 4]));

router.get('/', ctrl.list);
router.post('/', ctrl.create);
router.post('/ensure', ctrl.ensure);

module.exports = router;
