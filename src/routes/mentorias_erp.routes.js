const express = require('express');
const router = express.Router();

const { erpToken } = require('../middlewares/erpToken.middleware');
const ctrl = require('../controllers/mentorias_erp.controller');

/* Integración servidor-a-servidor con el ERP (imporsuitpro). No hay sesión de
   sub-usuario detrás, así que no pasa por `auth.protect`: la puerta es el
   secreto compartido de `erpToken`. Ver `services/mentorias_erp.service.js`. */
router.use(erpToken);

router.get('/estado', ctrl.estado);
router.get('/ocupacion', ctrl.ocupacion);
router.post('/citas', ctrl.crear);
router.post('/citas/:id/cancelar', ctrl.cancelar);

module.exports = router;
