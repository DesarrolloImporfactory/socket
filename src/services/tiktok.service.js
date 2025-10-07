const axios = require('axios');
const TikTokOAuthService = require('./tiktok_oauth.service');

/**
 * Servicio principal para interactuar con la API de TikTok Business
 */
class TikTokService {
  static TIKTOK_BASE_URL = 'https://business-api.tiktok.com';

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

    // Verificar si el token ha expirado
    if (new Date() > connection.expires_at) {
      // Intentar refrescar el token
      try {
        await TikTokOAuthService.refreshAccessToken(
          connection.oauth_session_id
        );
        // Obtener la conexión actualizada
        const refreshedConnection =
          await TikTokOAuthService.getConnectionByConfigId(id_configuracion);
        return refreshedConnection.access_token;
      } catch (error) {
        throw new Error(
          'Token expirado y no se pudo refrescar. Necesita reautenticación.'
        );
      }
    }

    return connection.access_token;
  }

  /**
   * Realiza una petición autenticada a la API de TikTok
   */
  static async makeAuthenticatedRequest(
    id_configuracion,
    endpoint,
    params = {},
    method = 'GET'
  ) {
    const accessToken = await this.getAccessToken(id_configuracion);
    const connection = await TikTokOAuthService.getConnectionByConfigId(
      id_configuracion
    );

    const config = {
      method,
      url: `${this.TIKTOK_BASE_URL}${endpoint}`,
      headers: {
        'Access-Token': accessToken,
        'Content-Type': 'application/json',
      },
    };

    if (method === 'GET') {
      config.params = {
        ...params,
        advertiser_id: connection.business_account_id,
      };
    } else {
      config.data = {
        ...params,
        advertiser_id: connection.business_account_id,
      };
    }

    try {
      const response = await axios(config);

      if (response.data.code !== 0) {
        throw new Error(`TikTok API error: ${response.data.message}`);
      }

      return response.data;
    } catch (error) {
      console.error(
        '[TIKTOK_SERVICE] Error en makeAuthenticatedRequest:',
        error
      );
      throw new Error(`Error en petición a TikTok API: ${error.message}`);
    }
  }

  /**
   * Obtiene las campañas de una cuenta publicitaria
   */
  static async getCampaigns({ id_configuracion, limit = 10, page = 1 }) {
    try {
      const response = await this.makeAuthenticatedRequest(
        id_configuracion,
        '/open_api/v1.3/campaign/get/',
        {
          page_size: limit,
          page: page,
          fields: [
            'campaign_id',
            'campaign_name',
            'campaign_type',
            'status',
            'objective_type',
            'budget',
            'budget_mode',
            'create_time',
            'modify_time',
          ].join(','),
        }
      );

      return {
        data: response.data.list || [],
        pagination: response.data.page_info || {},
      };
    } catch (error) {
      console.error('[TIKTOK_SERVICE] Error en getCampaigns:', error);
      throw new Error(`Error al obtener campañas: ${error.message}`);
    }
  }

  /**
   * Obtiene los grupos de anuncios de una campaña
   */
  static async getAdGroups({
    id_configuracion,
    campaign_id,
    limit = 10,
    page = 1,
  }) {
    try {
      const response = await this.makeAuthenticatedRequest(
        id_configuracion,
        '/open_api/v1.3/adgroup/get/',
        {
          campaign_ids: [campaign_id],
          page_size: limit,
          page: page,
          fields: [
            'adgroup_id',
            'adgroup_name',
            'campaign_id',
            'status',
            'budget',
            'bid_type',
            'bid_price',
            'optimization_goal',
            'create_time',
            'modify_time',
          ].join(','),
        }
      );

      return {
        data: response.data.list || [],
        pagination: response.data.page_info || {},
      };
    } catch (error) {
      console.error('[TIKTOK_SERVICE] Error en getAdGroups:', error);
      throw new Error(`Error al obtener grupos de anuncios: ${error.message}`);
    }
  }

  /**
   * Obtiene los anuncios de un grupo de anuncios
   */
  static async getAds({ id_configuracion, ad_group_id, limit = 10, page = 1 }) {
    try {
      const response = await this.makeAuthenticatedRequest(
        id_configuracion,
        '/open_api/v1.3/ad/get/',
        {
          adgroup_ids: [ad_group_id],
          page_size: limit,
          page: page,
          fields: [
            'ad_id',
            'ad_name',
            'adgroup_id',
            'status',
            'ad_format',
            'creative_material_mode',
            'create_time',
            'modify_time',
          ].join(','),
        }
      );

      return {
        data: response.data.list || [],
        pagination: response.data.page_info || {},
      };
    } catch (error) {
      console.error('[TIKTOK_SERVICE] Error en getAds:', error);
      throw new Error(`Error al obtener anuncios: ${error.message}`);
    }
  }

  /**
   * Obtiene reportes de rendimiento
   */
  static async getReports({
    id_configuracion,
    level,
    ids,
    start_date,
    end_date,
    metrics,
  }) {
    try {
      const endpointMap = {
        campaign: '/open_api/v1.3/report/integrated/get/',
        adgroup: '/open_api/v1.3/report/integrated/get/',
        ad: '/open_api/v1.3/report/integrated/get/',
      };

      const dimensionMap = {
        campaign: 'campaign_ids',
        adgroup: 'adgroup_ids',
        ad: 'ad_ids',
      };

      const params = {
        report_type: 'BASIC',
        data_level: level.toUpperCase(),
        dimensions: [dimensionMap[level]],
        metrics: metrics,
        start_date:
          start_date ||
          new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
            .toISOString()
            .split('T')[0],
        end_date: end_date || new Date().toISOString().split('T')[0],
        page_size: 1000,
        page: 1,
      };

      params[dimensionMap[level]] = ids;

      const response = await this.makeAuthenticatedRequest(
        id_configuracion,
        endpointMap[level],
        params
      );

      // Calcular resumen
      const data = response.data.list || [];
      const summary = this.calculateReportSummary(data, metrics);

      return {
        data,
        summary,
      };
    } catch (error) {
      console.error('[TIKTOK_SERVICE] Error en getReports:', error);
      throw new Error(`Error al obtener reportes: ${error.message}`);
    }
  }

  /**
   * Calcula el resumen de métricas de un reporte
   */
  static calculateReportSummary(data, metrics) {
    const summary = {};

    metrics.forEach((metric) => {
      const values = data.map((item) =>
        parseFloat(item.metrics?.[metric] || 0)
      );
      summary[metric] = {
        total: values.reduce((sum, val) => sum + val, 0),
        average:
          values.length > 0
            ? values.reduce((sum, val) => sum + val, 0) / values.length
            : 0,
        max: Math.max(...values),
        min: Math.min(...values),
      };
    });

    return summary;
  }

  /**
   * Obtiene las audiencias personalizadas
   */
  static async getAudiences({ id_configuracion, limit = 10, page = 1 }) {
    try {
      const response = await this.makeAuthenticatedRequest(
        id_configuracion,
        '/open_api/v1.3/dmp/custom_audience/list/',
        {
          page_size: limit,
          page: page,
        }
      );

      return {
        data: response.data.list || [],
        pagination: response.data.page_info || {},
      };
    } catch (error) {
      console.error('[TIKTOK_SERVICE] Error en getAudiences:', error);
      throw new Error(`Error al obtener audiencias: ${error.message}`);
    }
  }

  /**
   * Crea una nueva audiencia personalizada
   */
  static async createAudience({
    id_configuracion,
    audience_name,
    audience_type,
    file_paths,
    retention_days,
  }) {
    try {
      const params = {
        custom_audience_name: audience_name,
        audience_type: audience_type,
        retention_days: retention_days,
      };

      if (file_paths && file_paths.length > 0) {
        params.file_paths = file_paths;
      }

      const response = await this.makeAuthenticatedRequest(
        id_configuracion,
        '/open_api/v1.3/dmp/custom_audience/create/',
        params,
        'POST'
      );

      return response.data;
    } catch (error) {
      console.error('[TIKTOK_SERVICE] Error en createAudience:', error);
      throw new Error(`Error al crear audiencia: ${error.message}`);
    }
  }

  /**
   * Verifica el estado de la conexión
   */
  static async getConnectionStatus(id_configuracion) {
    try {
      const connection = await TikTokOAuthService.getConnectionByConfigId(
        id_configuracion
      );

      if (!connection) {
        return {
          connected: false,
          status: 'not_connected',
          message: 'No hay conexión de TikTok configurada',
        };
      }

      // Verificar si el token ha expirado
      const isExpired = new Date() > connection.expires_at;

      if (isExpired) {
        return {
          connected: true,
          status: 'token_expired',
          message: 'Token expirado, necesita reautenticación',
          expires_at: connection.expires_at,
          platform: connection.platform,
          business_account_id: connection.business_account_id,
        };
      }

      // Hacer una petición simple para verificar que la conexión funciona
      try {
        await this.makeAuthenticatedRequest(
          id_configuracion,
          '/open_api/v1.3/advertiser/info/'
        );

        return {
          connected: true,
          status: 'active',
          message: 'Conexión activa y funcionando',
          expires_at: connection.expires_at,
          platform: connection.platform,
          business_account_id: connection.business_account_id,
          last_sync: connection.last_sync,
        };
      } catch (error) {
        return {
          connected: true,
          status: 'error',
          message: `Error en la conexión: ${error.message}`,
          expires_at: connection.expires_at,
          platform: connection.platform,
          business_account_id: connection.business_account_id,
        };
      }
    } catch (error) {
      console.error('[TIKTOK_SERVICE] Error en getConnectionStatus:', error);
      throw new Error(
        `Error al verificar estado de conexión: ${error.message}`
      );
    }
  }

  /**
   * Sincroniza datos de TikTok
   */
  static async syncData({ id_configuracion, sync_type }) {
    try {
      const result = {
        started_at: new Date(),
        sync_type,
        results: {},
      };

      if (sync_type === 'all' || sync_type === 'campaigns') {
        const campaigns = await this.getCampaigns({
          id_configuracion,
          limit: 1000,
        });
        result.results.campaigns = {
          count: campaigns.data.length,
          synced_at: new Date(),
        };
      }

      if (sync_type === 'all' || sync_type === 'ads') {
        // Obtener todas las campañas primero
        const campaigns = await this.getCampaigns({
          id_configuracion,
          limit: 1000,
        });
        let totalAdGroups = 0;
        let totalAds = 0;

        for (const campaign of campaigns.data) {
          const adGroups = await this.getAdGroups({
            id_configuracion,
            campaign_id: campaign.campaign_id,
            limit: 1000,
          });
          totalAdGroups += adGroups.data.length;

          for (const adGroup of adGroups.data) {
            const ads = await this.getAds({
              id_configuracion,
              ad_group_id: adGroup.adgroup_id,
              limit: 1000,
            });
            totalAds += ads.data.length;
          }
        }

        result.results.ad_groups = {
          count: totalAdGroups,
          synced_at: new Date(),
        };

        result.results.ads = {
          count: totalAds,
          synced_at: new Date(),
        };
      }

      if (sync_type === 'all' || sync_type === 'metrics') {
        // Obtener métricas básicas de campañas de los últimos 30 días
        const campaigns = await this.getCampaigns({
          id_configuracion,
          limit: 1000,
        });
        const campaignIds = campaigns.data.map((c) => c.campaign_id);

        if (campaignIds.length > 0) {
          const reports = await this.getReports({
            id_configuracion,
            level: 'campaign',
            ids: campaignIds,
            metrics: ['impressions', 'clicks', 'conversions', 'cost'],
          });

          result.results.metrics = {
            campaigns_with_data: reports.data.length,
            synced_at: new Date(),
            summary: reports.summary,
          };
        }
      }

      // Actualizar timestamp de última sincronización
      const connection = await TikTokOAuthService.getConnectionByConfigId(
        id_configuracion
      );
      if (connection) {
        const { TikTokConnection } =
          require('../models/initModels').getModels();
        await TikTokConnection.update(
          {
            last_sync: new Date(),
            status: 'active',
          },
          { where: { id_configuracion } }
        );
      }

      result.completed_at = new Date();
      return result;
    } catch (error) {
      console.error('[TIKTOK_SERVICE] Error en syncData:', error);
      throw new Error(`Error al sincronizar datos: ${error.message}`);
    }
  }
}

module.exports = TikTokService;
