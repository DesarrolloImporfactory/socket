const express = require('express');
const router = express.Router();

const messengerController = require('../controllers/messenger.controller');
const verifyFBSignature = require('../middlewares/verifyFacebookSignature.middleware');

//No colocamos authMiddleware: Facebook no enviara el JWT.

//Get para verificacion
router.get('/webhook', messengerController.verifyWebhook);

//POST para recibir eventos (con validacion de firma)
router.post('/webhook', verifyFBSignature, messengerController.receiveWebhook);

module.exports = router;
