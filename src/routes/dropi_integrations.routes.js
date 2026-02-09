const express = require('express');
const router = express.Router();

const auth = require('../middlewares/auth.middleware');
const ctrl = require('../controllers/dropi_integrations.controller');

router.use(auth.protect);

//CRUD Integrations
router.get('/', auth.protectConfigOwner, ctrl.list);
router.post('/', auth.protectConfigOwner, ctrl.create);
router.patch('/:id', ctrl.update);
router.delete('/:id', ctrl.remove);

//Crear orden
router.post(
  '/orders/myorders',
  auth.protectConfigOwner,
  ctrl.createOrderMyOrders,
);

//Consultar ordenes (post hacia dropi con filtros)
router.post(
  '/orders/myorders/list',
  auth.protectConfigOwner,
  ctrl.listMyOrders,
);

//Obtener Productos Dropi
router.post('/products/index', auth.protectConfigOwner, ctrl.listProductsIndex);

//Consultar States (con country_id)
router.get('/location/states', auth.protectConfigOwner, ctrl.listStates);

//Obtener Cities (con body id_configuracion, department_id, rate_type)
router.post('/location/cities', auth.protectConfigOwner, ctrl.listCities);

module.exports = router;
