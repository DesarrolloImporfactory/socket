const express = require('express');
const router = express.Router();

const tikTokOAuthController = require('../controllers/tiktok_oauth.controller');
const tikTokController = require('../controllers/tiktok.controller');
const tikTokWebhookController = require('../controllers/tiktok_webhook.controller');
const tikTokMiddleware = require('../middlewares/tiktok.middleware');
const tikTokWebhookMiddleware = require('../middlewares/tiktok_webhook.middleware');

// 1. Obtener URL de login de TikTok Business
// GET /api/v1/tiktok/login-url?id_configuracion=123&redirect_uri=https://tu.front/conexiones&platform=web
router.get('/login-url', tikTokOAuthController.getLoginUrl);

// 2. Intercambio de código de autorización por access token
// POST /api/v1/tiktok/oauth/exchange
// body: { code, id_configuracion, redirect_uri, platform }
router.post('/oauth/exchange', tikTokOAuthController.exchangeCode);

// 3. Obtener información del perfil del usuario autenticado
// GET /api/v1/tiktok/profile?oauth_session_id=123
router.get('/profile', tikTokOAuthController.getUserProfile);

// 4. Listar cuentas de negocio del usuario autenticado
// GET /api/v1/tiktok/business-accounts?oauth_session_id=123
router.get('/business-accounts', tikTokOAuthController.getBusinessAccounts);

// 5. Conectar una cuenta de negocio a una configuración
// POST /api/v1/tiktok/connect
// body: { oauth_session_id, id_configuracion, business_account_id }
router.post('/connect', tikTokOAuthController.connectBusinessAccount);

// 6. Refrescar token de acceso
// GET /api/v1/tiktok/refresh-token?oauth_session_id=123
router.get('/refresh-token', tikTokOAuthController.refreshToken);

// 7. Desconectar cuenta de TikTok de una configuración
// DELETE /api/v1/tiktok/disconnect?id_configuracion=123
router.delete('/disconnect', tikTokOAuthController.disconnectAccount);

// === FUNCIONALIDADES DE TIKTOK BUSINESS ===

// 8. Obtener campañas de TikTok Ads
// GET /api/v1/tiktok/campaigns?id_configuracion=123&limit=10&page=1
router.get(
  '/campaigns',
  tikTokMiddleware.logTikTokRequest,
  tikTokMiddleware.validatePagination,
  tikTokMiddleware.validateTikTokConnection,
  tikTokController.getCampaigns
);

// 9. Obtener grupos de anuncios
// GET /api/v1/tiktok/ad-groups?id_configuracion=123&campaign_id=456&limit=10&page=1
router.get(
  '/ad-groups',
  tikTokMiddleware.logTikTokRequest,
  tikTokMiddleware.validatePagination,
  tikTokMiddleware.validateTikTokIds(['campaign_id']),
  tikTokMiddleware.validateTikTokConnection,
  tikTokController.getAdGroups
);

// 10. Obtener anuncios
// GET /api/v1/tiktok/ads?id_configuracion=123&ad_group_id=456&limit=10&page=1
router.get(
  '/ads',
  tikTokMiddleware.logTikTokRequest,
  tikTokMiddleware.validatePagination,
  tikTokMiddleware.validateTikTokIds(['ad_group_id']),
  tikTokMiddleware.validateTikTokConnection,
  tikTokController.getAds
);

// 11. Obtener reportes de rendimiento
// GET /api/v1/tiktok/reports?id_configuracion=123&level=campaign&ids=123,456&start_date=2023-01-01&end_date=2023-12-31
router.get(
  '/reports',
  tikTokMiddleware.logTikTokRequest,
  tikTokMiddleware.validateDateRange,
  tikTokMiddleware.validateTikTokIds(['ids']),
  tikTokMiddleware.validateTikTokConnection,
  tikTokController.getReports
);

// 12. Obtener audiencias personalizadas
// GET /api/v1/tiktok/audiences?id_configuracion=123&limit=10&page=1
router.get(
  '/audiences',
  tikTokMiddleware.logTikTokRequest,
  tikTokMiddleware.validatePagination,
  tikTokMiddleware.validateTikTokConnection,
  tikTokController.getAudiences
);

// 13. Crear audiencia personalizada
// POST /api/v1/tiktok/audiences
router.post(
  '/audiences',
  tikTokMiddleware.logTikTokRequest,
  tikTokMiddleware.validateTikTokConnection,
  tikTokController.createAudience
);

// 14. Verificar estado de la conexión
// GET /api/v1/tiktok/connection-status?id_configuracion=123
router.get(
  '/connection-status',
  tikTokMiddleware.logTikTokRequest,
  tikTokController.getConnectionStatus
);

// 15. Sincronizar datos de TikTok
// POST /api/v1/tiktok/sync-data
router.post(
  '/sync-data',
  tikTokMiddleware.logTikTokRequest,
  tikTokMiddleware.validateTikTokConnection,
  tikTokController.syncData
);

// === WEBHOOKS DE TIKTOK ===

// 16. Verificar webhook (para configuración inicial)
// GET /api/v1/tiktok/webhook/verify
router.get(
  '/webhook/verify',
  tikTokWebhookMiddleware.logWebhookRequest,
  tikTokWebhookMiddleware.validateWebhookStructure,
  tikTokWebhookController.verifyWebhook
);

// 17. Recibir eventos de webhook
// POST /api/v1/tiktok/webhook/receive
router.post(
  '/webhook/receive',
  tikTokWebhookMiddleware.webhookRateLimit,
  tikTokWebhookMiddleware.advancedWebhookLogger,
  tikTokWebhookMiddleware.validateTikTokOrigin,
  tikTokWebhookMiddleware.validateTikTokWebhookSignature,
  tikTokWebhookMiddleware.validateWebhookStructure,
  tikTokWebhookController.receiveWebhook
);

// 18. Suscribir a eventos de webhook
// POST /api/v1/tiktok/webhook/subscribe
router.post(
  '/webhook/subscribe',
  tikTokMiddleware.logTikTokRequest,
  tikTokMiddleware.validateTikTokConnection,
  tikTokWebhookController.subscribeWebhook
);

// 19. Obtener suscripciones activas
// GET /api/v1/tiktok/webhook/subscriptions
router.get(
  '/webhook/subscriptions',
  tikTokMiddleware.logTikTokRequest,
  tikTokWebhookController.getSubscriptions
);

// 20. Cancelar suscripción de webhook
// DELETE /api/v1/tiktok/webhook/unsubscribe
router.delete(
  '/webhook/unsubscribe',
  tikTokMiddleware.logTikTokRequest,
  tikTokWebhookController.unsubscribeWebhook
);

// 21. Obtener historial de eventos de webhook
// GET /api/v1/tiktok/webhook/events
router.get(
  '/webhook/events',
  tikTokMiddleware.logTikTokRequest,
  tikTokMiddleware.validatePagination,
  tikTokWebhookController.getWebhookEvents
);

// 22. Probar webhook (enviar evento de prueba)
// POST /api/v1/tiktok/webhook/test
router.post(
  '/webhook/test',
  tikTokMiddleware.logTikTokRequest,
  tikTokWebhookController.testWebhook
);

// 25. Generar logs de prueba para testing
// POST /api/v1/tiktok/webhook/generate-test-logs
router.post(
  '/webhook/generate-test-logs',
  tikTokMiddleware.logTikTokRequest,
  tikTokWebhookController.generateTestLogs
);

// 23. Dashboard de logs de webhooks
// GET /api/v1/tiktok/webhook/logs
router.get(
  '/webhook/logs',
  tikTokMiddleware.logTikTokRequest,
  tikTokWebhookController.getWebhookLogs
);

// 24. Estadísticas de webhooks
// GET /api/v1/tiktok/webhook/stats
router.get(
  '/webhook/stats',
  tikTokMiddleware.logTikTokRequest,
  tikTokWebhookController.getWebhookStats
);

// Middleware de manejo de errores específico solo para endpoints de procesamiento de webhooks
router.use('/webhook/verify', tikTokWebhookMiddleware.handleWebhookError);
router.use('/webhook/receive', tikTokWebhookMiddleware.handleWebhookError);

module.exports = router;
