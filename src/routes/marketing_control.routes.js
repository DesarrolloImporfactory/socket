const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/marketing_control.controller');
const {
  protect,
  protectConfigOwner,
} = require('../middlewares/auth.middleware');
const excluirRoles = require('../middlewares/excluirRoles.middleware');

/* Hasta el 2026-09-22 /dashboard y /healthz iban SIN protect: cualquiera con
   un id_configuracion leía ventas, inversión y ROAS de esa cuenta, y el
   repo es público. Ahora exigen sesión, que la conexión sea de la cuenta y
   un rol distinto de ventas (el asesor no tiene por qué ver los valores). */
router.use(protect);

router.get(
  '/dashboard',
  protectConfigOwner,
  excluirRoles('ventas'),
  ctrl.dashboard,
);
router.post(
  '/impuesto-ads',
  protectConfigOwner,
  excluirRoles('ventas'),
  ctrl.guardarImpuestoAds,
);
router.get('/healthz', protectConfigOwner, ctrl.healthz);

module.exports = router;
