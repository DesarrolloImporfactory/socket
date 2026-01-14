const express = require('express');
const router = express.Router();

const auth = require('../middlewares/auth.middleware');
const ctrl = require('../controllers/dropi_integrations.controller');

router.use(auth.protect);

router.get('/', ctrl.list);
router.post('/', ctrl.create);
router.patch('/:id', ctrl.update);
router.delete('/:id', ctrl.remove);

router.post('/orders/myorders', ctrl.createOrderMyOrders);

module.exports = router;
