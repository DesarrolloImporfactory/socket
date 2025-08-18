const express = require('express');
const router = express.Router();
const auth = require('../middlewares/auth.middleware');
const checkPlanActivo = require('../middlewares/checkPlanActivo.middleware');
const restrictToPlanes = require('../middlewares/restrictToPlanes.middleware');
const ctrl = require('../controllers/calendars.controller');

router.use(auth.protect);

router.get('/', ctrl.list);
router.post('/', ctrl.create);
router.post('/ensure', ctrl.ensure,checkPlanActivo,restrictToPlanes([2,3]));
module.exports = router;
