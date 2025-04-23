const configuracionesController = require('../controllers/configuraciones.controller');


const express = require('express');

const router = express.Router();

const { protect } = require('../middlewares/auth.middleware');

router.post('/obtener_template_transportadora', configuracionesController.obtener_template_transportadora);


module.exports = router;