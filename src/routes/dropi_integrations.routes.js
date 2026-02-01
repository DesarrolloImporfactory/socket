const express = require('express');
const router = express.Router();

const auth = require('../middlewares/auth.middleware');
const ctrl = require('../controllers/dropi_integrations.controller');

router.use(auth.protect);

//CRUD Integrations
router.get('/', ctrl.list);
router.post('/', ctrl.create);
router.patch('/:id', ctrl.update);
router.delete('/:id', ctrl.remove);

//Crear orden
router.post('/orders/myorders', ctrl.createOrderMyOrders);

//Consultar ordenes (post hacia dropi con filtros)
router.post('/orders/myorders/list', ctrl.listMyOrders);

module.exports = router;
