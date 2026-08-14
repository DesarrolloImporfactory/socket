const express = require('express');
const ctrl = require('../controllers/citas_solicitudes.controller');

const router = express.Router();

const { protect } = require('../middlewares/auth.middleware');
const checkPlanActivo = require('../middlewares/checkPlanActivo.middleware');

router.use(protect);

router.post('/listar', checkPlanActivo, ctrl.listar);
/* Confirmar y descartar NO pasan por checkPlanActivo: son la salida de un
   trabajo que ya está hecho. Dejar a alguien sin poder confirmar la cita que su
   bot ya prometió, porque venció el plan, deja al cliente final esperando en
   una puerta. */
router.post('/confirmar', ctrl.confirmar);
router.post('/descartar', ctrl.descartar);

module.exports = router;
