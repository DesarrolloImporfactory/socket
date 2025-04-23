const chat_service_Controller = require('../controllers/chat_service.controller')

const express = require('express');

const router = express.Router();

// const authMiddleware = require('../middlewares/auth.middleware');
// router.use(authMiddleware.protect);

router.get(
    '/ciudadProvincia/:id',
    chat_service_Controller.obtenerCiudadProvincia
);

module.exports = router;