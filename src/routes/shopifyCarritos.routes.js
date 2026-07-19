const express = require('express');
const router = express.Router();
const controller = require('../controllers/shopifyCarritosListController');
const { protect, protectConfigOwner } = require('../middlewares/auth.middleware');

// Todas requieren sesión + que la id_configuracion pertenezca a la cuenta.
// (evita que un usuario lea/modifique carritos de otra config)
router.get('/', protect, protectConfigOwner, controller.listar);
router.get(
  '/estadisticas',
  protect,
  protectConfigOwner,
  controller.estadisticas,
);
router.patch(
  '/:id/marcar-mensaje-enviado',
  protect,
  protectConfigOwner,
  controller.marcarMensajeEnviado,
);

module.exports = router;