const express = require('express');
const router = express.Router();

const messengerController = require('../controllers/messenger.controller');
const oauthController = require('../controllers/messenger_oauth.controller');
const verifyFBSignature = require('../middlewares/verifyFacebookSignature.middleware');
const conversationsController = require('../controllers/messenger_conversations.controller');
const messengerProfiles = require('../controllers/messenger_profiles.controller');
const messengerPagesController = require('../controllers/messenger_pages.controller');
const { protect } = require('../middlewares/auth.middleware');

//No colocamos authMiddleware: Facebook no enviara el JWT.

//Get para verificacion
router.get('/webhook', messengerController.verifyWebhook);

//POST para recibir eventos (con validacion de firma)
router.post('/webhook', verifyFBSignature, messengerController.receiveWebhook);

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

//Info y nombre de ms o ig para realizar upsert
router.post('/profiles/fetch-store', messengerProfiles.fetchAndStoreProfile);

//Obtener informacion del perfil del usuario
router.post('/profiles/fetch', messengerProfiles.fetchAndStoreProfile);

router.post('/profiles/refresh-missing', messengerProfiles.refreshMissing);

router.get('/pages/connections', messengerPagesController.listConnections);

// Salud de las conexiones: pregunta a Meta si el page_access_token sigue vivo.
// ?guardar=1 persiste el diagnóstico, ?marcar=1 además marca status='revoked'.
//
// Este router va sin authMiddleware global porque Facebook no manda JWT en los
// webhooks, pero esta ruta sí la pide: la llama el front (no Meta), devuelve
// diagnóstico de conexiones de un cliente y dispara llamadas a Graph, así que
// dejarla abierta sería un vector de abuso.
router.get('/pages/health', protect, messengerPagesController.salud);

module.exports = router;
