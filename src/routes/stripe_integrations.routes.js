const express = require('express');
const router = express.Router();

const auth = require('../middlewares/auth.middleware');
const ctrl = require('../controllers/stripe_integrations.controller');

router.use(auth.protect);

// Lo consulta el chat para mostrar u ocultar "Crear enlace de pago":
// cualquier subusuario de la cuenta, por eso solo valida la propiedad.
router.get('/estado', auth.protectConfigOwner, ctrl.estado);

// Vinculación de la llave propia de Stripe (una por configuración).
router.get('/', auth.protectConfigOwner, ctrl.list);
router.post('/', auth.protectConfigOwner, ctrl.create);
router.patch('/:id', ctrl.update);
router.delete('/:id', ctrl.remove);
router.get('/:id/probar', ctrl.probarConexion);

module.exports = router;
