const express = require('express');
const router = express.Router();

const auth = require('../middlewares/auth.middleware');
const ctrl = require('../controllers/aliclik_integrations.controller');
const ordersCtrl = require('../controllers/aliclik_orders.controller');

router.use(auth.protect);

// Vista Pedidos: qué plataformas tiene conectadas esta configuración y el
// listado de órdenes de Aliclik desde el cache local.
router.post(
  '/plataformas-conectadas',
  auth.protectConfigOwner,
  ordersCtrl.plataformasConectadas,
);
router.post(
  '/orders/cache/list',
  auth.protectConfigOwner,
  ordersCtrl.listOrdersFromCache,
);

// CRUD de la vinculación con Aliclik. Las rutas con :id validan la propiedad
// dentro del controlador (assertConfigBelongsToOwner) porque el
// id_configuracion no viaja en la petición, se deduce de la fila.
router.get('/', auth.protectConfigOwner, ctrl.list);
router.post('/', auth.protectConfigOwner, ctrl.create);
router.patch('/:id', ctrl.update);
router.delete('/:id', ctrl.remove);

// Genera un secreto nuevo para el webhook (invalida la URL anterior).
router.post('/:id/rotar-webhook', ctrl.rotarWebhookSecret);

// Valida el token contra la API de Aliclik y devuelve la URL del webhook.
router.get('/:id/probar', ctrl.probarConexion);

module.exports = router;
