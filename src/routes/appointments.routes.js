const express = require('express');
const router = express.Router();
const auth = require('../middlewares/auth.middleware');
const ctrl = require('../controllers/appointments.controller');

router.use(auth.protect);

router.get('/', ctrl.list); // ?calendar_id=&start=&end=&user_ids=1,2
router.post('/', ctrl.create); // crear/bloquear
router.patch('/:id', ctrl.update); // reprogramar/editar
router.post('/:id/cancel', ctrl.cancel);

module.exports = router;
