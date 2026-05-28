const express = require('express');
const router = express.Router();
const controller = require('../controllers/shopifyPlantillaController');

router.post('/obtener', controller.obtener);
router.post('/guardar', controller.guardar);

module.exports = router;
