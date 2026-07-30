const express = require('express');
const ctrl = require('../controllers/profesionales_chat_center.controller');

const router = express.Router();

const { protect } = require('../middlewares/auth.middleware');
const checkPlanActivo = require('../middlewares/checkPlanActivo.middleware');

router.use(protect);

router.post('/listar', checkPlanActivo, ctrl.listar);
router.post('/crear', ctrl.crear);
router.post('/actualizar', ctrl.actualizar);
router.delete('/eliminar', ctrl.eliminar);

module.exports = router;
