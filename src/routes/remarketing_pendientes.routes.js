const remarketing_pendientesController = require('../controllers/remarketing_pendientes.controller');

const express = require('express');

const router = express.Router();

router.post('/cancel', remarketing_pendientesController.cancel);
router.post(
  '/cancel-by-thread',
  remarketing_pendientesController.cancelByThread
);

module.exports = router;
