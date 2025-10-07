const axios = require('axios');
const crypto = require('crypto');
const TikTokOAuthService = require('./tiktok_oauth.service');
const { getModels } = require('../models/initModels');

/**
 * Servicio para manejar webhooks de TikTok Business
 */
class TikTokWebhookService {
  static TIKTOK_BASE_URL = 'https://business-api.tiktok.com';

  /**
   * Procesa un evento de webhook recibido
   */
  static async processWebhookEvent(webhookData) {
    try {
      const { data } = webhookData;

      // Guardar el evento en la base de datos
      await this.saveWebhookEvent(webhookData);

      // Procesar según el tipo de evento
      for (const event of data) {
        const eventType = event.event_type;

        console.log(`[TIKTOK_WEBHOOK] Procesando evento: ${eventType}`);

        switch (eventType) {
          case 'CAMPAIGN_STATUS_CHANGE':
            await this.handleCampaignStatusChange(event);
            break;

          case 'AD_GROUP_STATUS_CHANGE':
            await this.handleAdGroupStatusChange(event);
            break;

          case 'AD_STATUS_CHANGE':
            await this.handleAdStatusChange(event);
            break;

          case 'BUDGET_EXHAUSTED':
            await this.handleBudgetExhausted(event);
            break;

          case 'BID_TOO_LOW':
            await this.handleBidTooLow(event);
            break;

          case 'CREATIVE_REJECTED':
            await this.handleCreativeRejected(event);
            break;

          case 'CONVERSION_EVENT':
            await this.handleConversionEvent(event);
            break;

          default:
            console.log(
              `[TIKTOK_WEBHOOK] Tipo de evento no manejado: ${eventType}`
            );
            break;
        }
      }

      return { success: true, processed_events: data.length };
    } catch (error) {
      console.error('[TIKTOK_WEBHOOK] Error procesando evento:', error);
      throw error;
    }
  }

  /**
   * Guarda el evento de webhook en la base de datos
   */
  static async saveWebhookEvent(webhookData) {
    try {
      const { TikTokWebhookEvent } = getModels();

      const eventData = {
        event_id: webhookData.event_id || null,
        event_type: webhookData.data?.[0]?.event_type || 'UNKNOWN',
        advertiser_id: webhookData.data?.[0]?.advertiser_id || null,
        campaign_id: webhookData.data?.[0]?.campaign_id || null,
        ad_group_id: webhookData.data?.[0]?.ad_group_id || null,
        ad_id: webhookData.data?.[0]?.ad_id || null,
        event_data: JSON.stringify(webhookData),
        received_at: new Date(),
        processed: false,
      };

      await TikTokWebhookEvent.create(eventData);
      console.log(
        `[TIKTOK_WEBHOOK] Evento guardado en BD: ${eventData.event_type}`
      );
    } catch (error) {
      console.error('[TIKTOK_WEBHOOK] Error guardando evento:', error);
      // No relanzar el error para no afectar el procesamiento
    }
  }

  /**
   * Maneja cambios de estado de campaña
   */
  static async handleCampaignStatusChange(event) {
    console.log(
      `[TIKTOK_WEBHOOK] Campaña ${event.campaign_id} cambió estado a: ${event.new_status}`
    );

    // Aquí puedes agregar lógica específica:
    // - Notificar a usuarios
    // - Actualizar base de datos local
    // - Enviar emails/slack/etc

    // Ejemplo: notificar por email si una campaña se pausa
    if (event.new_status === 'PAUSED') {
      await this.sendNotification({
        type: 'campaign_paused',
        message: `La campaña "${event.campaign_name}" se ha pausado`,
        advertiser_id: event.advertiser_id,
        campaign_id: event.campaign_id,
      });
    }
  }

  /**
   * Maneja cambios de estado de grupo de anuncios
   */
  static async handleAdGroupStatusChange(event) {
    console.log(
      `[TIKTOK_WEBHOOK] Grupo de anuncios ${event.ad_group_id} cambió estado a: ${event.new_status}`
    );

    // Lógica similar a campaigns
  }

  /**
   * Maneja cambios de estado de anuncios
   */
  static async handleAdStatusChange(event) {
    console.log(
      `[TIKTOK_WEBHOOK] Anuncio ${event.ad_id} cambió estado a: ${event.new_status}`
    );

    // Si un anuncio es rechazado, notificar inmediatamente
    if (event.new_status === 'REJECTED') {
      await this.sendNotification({
        type: 'ad_rejected',
        message: `El anuncio "${event.ad_name}" fue rechazado: ${event.rejection_reason}`,
        advertiser_id: event.advertiser_id,
        ad_id: event.ad_id,
      });
    }
  }

  /**
   * Maneja alertas de presupuesto agotado
   */
  static async handleBudgetExhausted(event) {
    console.log(
      `[TIKTOK_WEBHOOK] Presupuesto agotado para: ${
        event.campaign_id || event.ad_group_id
      }`
    );

    await this.sendNotification({
      type: 'budget_exhausted',
      message: `Presupuesto agotado para ${
        event.campaign_name || event.ad_group_name
      }`,
      advertiser_id: event.advertiser_id,
      campaign_id: event.campaign_id,
      ad_group_id: event.ad_group_id,
    });
  }

  /**
   * Maneja alertas de puja muy baja
   */
  static async handleBidTooLow(event) {
    console.log(`[TIKTOK_WEBHOOK] Puja muy baja para: ${event.ad_group_id}`);

    await this.sendNotification({
      type: 'bid_too_low',
      message: `La puja para "${event.ad_group_name}" es muy baja y puede afectar el rendimiento`,
      advertiser_id: event.advertiser_id,
      ad_group_id: event.ad_group_id,
    });
  }

  /**
   * Maneja rechazos de creativos
   */
  static async handleCreativeRejected(event) {
    console.log(`[TIKTOK_WEBHOOK] Creativo rechazado: ${event.creative_id}`);

    await this.sendNotification({
      type: 'creative_rejected',
      message: `Creativo rechazado: ${event.rejection_reason}`,
      advertiser_id: event.advertiser_id,
      creative_id: event.creative_id,
    });
  }

  /**
   * Maneja eventos de conversión
   */
  static async handleConversionEvent(event) {
    console.log(
      `[TIKTOK_WEBHOOK] Evento de conversión: ${event.conversion_type}`
    );

    // Actualizar métricas en tiempo real
    // Enviar a analytics
    // etc.
  }

  /**
   * Suscribe a eventos de webhook
   */
  static async subscribeToEvents({
    id_configuracion,
    event_types,
    callback_url,
  }) {
    try {
      const accessToken = await this.getAccessToken(id_configuracion);
      const connection = await TikTokOAuthService.getConnectionByConfigId(
        id_configuracion
      );

      const response = await axios.post(
        `${this.TIKTOK_BASE_URL}/open_api/v1.3/webhook/subscribe/`,
        {
          advertiser_id: connection.business_account_id,
          event_types: event_types,
          callback_url: callback_url,
          verify_token: process.env.TIKTOK_WEBHOOK_VERIFY_TOKEN,
        },
        {
          headers: {
            'Access-Token': accessToken,
            'Content-Type': 'application/json',
          },
        }
      );

      if (response.data.code !== 0) {
        throw new Error(
          `TikTok webhook subscribe error: ${response.data.message}`
        );
      }

      // Guardar suscripción en BD
      const { TikTokWebhookSubscription } = getModels();
      const subscription = await TikTokWebhookSubscription.create({
        id_configuracion,
        subscription_id: response.data.data.subscription_id,
        event_types: JSON.stringify(event_types),
        callback_url,
        status: 'active',
        created_at: new Date(),
      });

      return subscription;
    } catch (error) {
      console.error('[TIKTOK_WEBHOOK] Error suscribiendo a webhook:', error);
      throw new Error(`Error al suscribir webhook: ${error.message}`);
    }
  }

  /**
   * Obtiene las suscripciones activas
   */
  static async getSubscriptions(id_configuracion) {
    try {
      const { TikTokWebhookSubscription } = getModels();

      const subscriptions = await TikTokWebhookSubscription.findAll({
        where: {
          id_configuracion,
          status: 'active',
        },
        order: [['created_at', 'DESC']],
      });

      return subscriptions.map((sub) => ({
        subscription_id: sub.subscription_id,
        event_types: JSON.parse(sub.event_types),
        callback_url: sub.callback_url,
        status: sub.status,
        created_at: sub.created_at,
      }));
    } catch (error) {
      console.error('[TIKTOK_WEBHOOK] Error obteniendo suscripciones:', error);
      throw new Error(`Error al obtener suscripciones: ${error.message}`);
    }
  }

  /**
   * Cancela una suscripción de webhook
   */
  static async unsubscribeFromEvents({ id_configuracion, subscription_id }) {
    try {
      const accessToken = await this.getAccessToken(id_configuracion);

      const response = await axios.post(
        `${this.TIKTOK_BASE_URL}/open_api/v1.3/webhook/unsubscribe/`,
        {
          subscription_id: subscription_id,
        },
        {
          headers: {
            'Access-Token': accessToken,
            'Content-Type': 'application/json',
          },
        }
      );

      if (response.data.code !== 0) {
        throw new Error(
          `TikTok webhook unsubscribe error: ${response.data.message}`
        );
      }

      // Actualizar estado en BD
      const { TikTokWebhookSubscription } = getModels();
      await TikTokWebhookSubscription.update(
        { status: 'cancelled' },
        { where: { id_configuracion, subscription_id } }
      );

      return true;
    } catch (error) {
      console.error('[TIKTOK_WEBHOOK] Error cancelando suscripción:', error);
      throw new Error(`Error al cancelar suscripción: ${error.message}`);
    }
  }

  /**
   * Obtiene el historial de eventos de webhook
   */
  static async getWebhookEvents({ id_configuracion, limit, page, event_type }) {
    try {
      const { TikTokWebhookEvent } = getModels();
      const connection = await TikTokOAuthService.getConnectionByConfigId(
        id_configuracion
      );

      if (!connection) {
        throw new Error('Conexión no encontrada');
      }

      const where = {
        advertiser_id: connection.business_account_id,
      };

      if (event_type) {
        where.event_type = event_type;
      }

      const offset = (page - 1) * limit;

      const { count, rows } = await TikTokWebhookEvent.findAndCountAll({
        where,
        limit,
        offset,
        order: [['received_at', 'DESC']],
      });

      return {
        data: rows.map((event) => ({
          id: event.id,
          event_type: event.event_type,
          event_data: JSON.parse(event.event_data),
          received_at: event.received_at,
          processed: event.processed,
        })),
        pagination: {
          total: count,
          page,
          limit,
          pages: Math.ceil(count / limit),
        },
      };
    } catch (error) {
      console.error('[TIKTOK_WEBHOOK] Error obteniendo eventos:', error);
      throw new Error(`Error al obtener eventos: ${error.message}`);
    }
  }

  /**
   * Envía un evento de prueba
   */
  static async sendTestEvent({ id_configuracion, callback_url }) {
    try {
      const testEvent = {
        event_id: `test_${Date.now()}`,
        data: [
          {
            event_type: 'TEST_EVENT',
            advertiser_id: 'test_advertiser',
            timestamp: new Date().toISOString(),
            message: 'Este es un evento de prueba del webhook de TikTok',
          },
        ],
      };

      const response = await axios.post(callback_url, testEvent, {
        headers: {
          'Content-Type': 'application/json',
          'X-TikTok-Test-Event': 'true',
        },
        timeout: 10000,
      });

      return {
        status: response.status,
        success: response.status === 200,
        response_time: response.headers['x-response-time'] || null,
      };
    } catch (error) {
      console.error('[TIKTOK_WEBHOOK] Error enviando evento de prueba:', error);
      return {
        status: error.response?.status || 0,
        success: false,
        error: error.message,
      };
    }
  }

  /**
   * Obtiene el token de acceso para una configuración
   */
  static async getAccessToken(id_configuracion) {
    const connection = await TikTokOAuthService.getConnectionByConfigId(
      id_configuracion
    );

    if (!connection) {
      throw new Error(
        'No se encontró una conexión de TikTok para esta configuración'
      );
    }

    // Verificar si el token ha expirado y refrescarlo si es necesario
    if (new Date() > connection.expires_at) {
      await TikTokOAuthService.refreshAccessToken(connection.oauth_session_id);
      const refreshedConnection =
        await TikTokOAuthService.getConnectionByConfigId(id_configuracion);
      return refreshedConnection.access_token;
    }

    return connection.access_token;
  }

  /**
   * Envía notificaciones (email, slack, etc.)
   */
  static async sendNotification({ type, message, ...eventData }) {
    try {
      console.log(`[TIKTOK_WEBHOOK] Notificación ${type}: ${message}`);

      // Aquí puedes integrar con:
      // - Servicio de email
      // - Slack
      // - Push notifications
      // - Webhook interno
      // - etc.

      // Ejemplo: guardar notificación en BD para mostrar en dashboard
      const { TikTokNotification } = getModels();
      await TikTokNotification.create({
        type,
        message,
        event_data: JSON.stringify(eventData),
        created_at: new Date(),
        read: false,
      });
    } catch (error) {
      console.error('[TIKTOK_WEBHOOK] Error enviando notificación:', error);
    }
  }

  /**
   * Valida la firma del webhook (opcional pero recomendado)
   */
  static validateWebhookSignature(payload, signature, secret) {
    const expectedSignature = crypto
      .createHmac('sha256', secret)
      .update(payload, 'utf8')
      .digest('hex');

    return crypto.timingSafeEqual(
      Buffer.from(signature, 'hex'),
      Buffer.from(expectedSignature, 'hex')
    );
  }
}

module.exports = TikTokWebhookService;
