const express = require('express');
const router = express.Router();

const messengerController = require('../controllers/messenger.controller');
const oauthController = require('../controllers/messenger_oauth.controller');
const verifyFBSignature = require('../middlewares/verifyFacebookSignature.middleware');
const conversationsController = require('../controllers/messenger_conversations.controller');
const messengerProfiles = require('../controllers/messenger_profiles.controller');
const messengerPagesController = require('../controllers/messenger_pages.controller');

//No colocamos authMiddleware: Facebook no enviara el JWT.

//Get para verificacion
router.get('/webhook', messengerController.verifyWebhook);

//POST para recibir eventos (con validacion de firma)
router.post('/webhook', messengerController.receiveWebhook);

// 1. OAuth de login (construida por server)
router.get('/facebook/login-url', oauthController.getLoginUrl);

// 2. Intercambio de code -> user token largo + crear sesión OAuth
router.post('/facebook/oauth/exchange', oauthController.exchangeCode);

// 3. Listar páginas del usuario (usando la sesión OAuth)
router.get('/facebook/pages', oauthController.listUserPages);

// 4. Conectar página a id_configuracion (suscribe + guarda token en DB)
router.post('/facebook/connect', oauthController.connectPage);

// Listar conversaciones por id_configuracion
router.get('/conversations', conversationsController.listConversations);

// Listar mensajes de una conversación
router.get('/conversations/:id/messages', conversationsController.listMessages);

//Obtener informacion del perfil del usuario
router.post('/profiles/fetch', messengerProfiles.fetchAndStoreProfile);

router.post('/profiles/refresh-missing', messengerProfiles.refreshMissing);

router.get('/pages/connections', messengerPagesController.listConnections);

module.exports = router;
