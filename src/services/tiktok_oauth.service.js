const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
const { getModels } = require('../models/initModels');

const getTikTokModels = () => {
  const models = getModels();
  return {
    TikTokOAuthSession: models.TikTokOAuthSession,
    TikTokConnection: models.TikTokConnection,
  };
};

/**
 * Servicio para manejar OAuth de TikTok Business
 */
class TikTokOAuthService {
  static TIKTOK_BASE_URL = 'https://business-api.tiktok.com';
  static TIKTOK_AUTH_URL = 'https://business-api.tiktok.com/portal/auth';

  /**
   * Construye la URL de autorización de TikTok
   */
  static buildLoginUrl({ id_configuracion, redirect_uri, platform = 'web' }) {
    const state = Buffer.from(
      JSON.stringify({
        id_configuracion,
        redirect_uri,
        platform,
        nonce: uuidv4(),
      })
    ).toString('base64');

    const params = new URLSearchParams({
      app_id: process.env.TIKTOK_APP_ID,
      state,
      redirect_uri,
      scope: 'business_basic,business_user_info,ads_read,ads_write', // Ajusta según tus necesidades
    });

    return `${this.TIKTOK_AUTH_URL}?${params.toString()}`;
  }

  /**
   * Intercambia el código de autorización por un access token
   */
  static async exchangeCodeAndCreateSession({
    code,
    id_configuracion,
    redirect_uri,
    platform,
  }) {
    const { TikTokOAuthSession } = getTikTokModels();

    try {
      // 1. Intercambiar código por access token
      const tokenResponse = await axios.post(
        `${this.TIKTOK_BASE_URL}/open_api/v1.3/oauth2/access_token/`,
        {
          app_id: process.env.TIKTOK_APP_ID,
          app_secret: process.env.TIKTOK_APP_SECRET,
          auth_code: code,
          grant_type: 'authorization_code',
        },
        {
          headers: {
            'Content-Type': 'application/json',
          },
        }
      );

      if (tokenResponse.data.code !== 0) {
        throw new Error(`TikTok OAuth error: ${tokenResponse.data.message}`);
      }

      const { access_token, refresh_token, expires_in, advertiser_ids } =
        tokenResponse.data.data;

      // 2. Crear sesión OAuth en la base de datos
      const sessionData = {
        id_configuracion,
        access_token,
        refresh_token,
        platform,
        redirect_uri,
        advertiser_ids: JSON.stringify(advertiser_ids || []),
        expires_at: new Date(Date.now() + expires_in * 1000),
        state: 'active',
        created_at: new Date(),
        updated_at: new Date(),
      };

      const session = await TikTokOAuthSession.create(sessionData);

      return session;
    } catch (error) {
      console.error(
        '[TIKTOK_OAUTH] Error en exchangeCodeAndCreateSession:',
        error
      );
      throw new Error(`Error al obtener token de TikTok: ${error.message}`);
    }
  }

  /**
   * Obtiene información del usuario desde una sesión OAuth
   */
  static async getUserProfileFromSession(oauth_session_id) {
    const { TikTokOAuthSession } = getTikTokModels();

    try {
      const session = await TikTokOAuthSession.findByPk(oauth_session_id);
      if (!session) {
        throw new Error('Sesión OAuth no encontrada');
      }

      // Verificar si el token ha expirado
      if (new Date() > session.expires_at) {
        throw new Error('Token expirado. Necesita reautenticación.');
      }

      const response = await axios.get(
        `${this.TIKTOK_BASE_URL}/open_api/v1.3/user/info/`,
        {
          headers: {
            'Access-Token': session.access_token,
          },
        }
      );

      if (response.data.code !== 0) {
        throw new Error(`TikTok API error: ${response.data.message}`);
      }

      return response.data.data;
    } catch (error) {
      console.error(
        '[TIKTOK_OAUTH] Error en getUserProfileFromSession:',
        error
      );
      throw new Error(`Error al obtener perfil de usuario: ${error.message}`);
    }
  }

  /**
   * Obtiene las cuentas de negocio del usuario
   */
  static async getBusinessAccountsFromSession(oauth_session_id) {
    const { TikTokOAuthSession } = getTikTokModels();

    try {
      const session = await TikTokOAuthSession.findByPk(oauth_session_id);
      if (!session) {
        throw new Error('Sesión OAuth no encontrada');
      }

      // Verificar si el token ha expirado
      if (new Date() > session.expires_at) {
        throw new Error('Token expirado. Necesita reautenticación.');
      }

      const response = await axios.get(
        `${this.TIKTOK_BASE_URL}/open_api/v1.3/advertiser/info/`,
        {
          headers: {
            'Access-Token': session.access_token,
          },
          params: {
            advertiser_ids: JSON.parse(session.advertiser_ids),
          },
        }
      );

      if (response.data.code !== 0) {
        throw new Error(`TikTok API error: ${response.data.message}`);
      }

      return response.data.data.list || [];
    } catch (error) {
      console.error(
        '[TIKTOK_OAUTH] Error en getBusinessAccountsFromSession:',
        error
      );
      throw new Error(`Error al obtener cuentas de negocio: ${error.message}`);
    }
  }

  /**
   * Conecta una cuenta de negocio de TikTok a una configuración
   */
  static async connectBusinessAccount({
    oauth_session_id,
    id_configuracion,
    business_account_id,
  }) {
    const { TikTokOAuthSession, TikTokConnection } = getTikTokModels();

    try {
      const session = await TikTokOAuthSession.findByPk(oauth_session_id);
      if (!session) {
        throw new Error('Sesión OAuth no encontrada');
      }

      // Verificar que el business_account_id esté en los advertiser_ids de la sesión
      const advertiserIds = JSON.parse(session.advertiser_ids);
      if (!advertiserIds.includes(business_account_id)) {
        throw new Error('La cuenta de negocio no pertenece a este usuario');
      }

      // Verificar si ya existe una conexión para esta configuración
      const existingConnection = await TikTokConnection.findOne({
        where: { id_configuracion },
      });

      if (existingConnection) {
        // Actualizar conexión existente
        await existingConnection.update({
          oauth_session_id,
          business_account_id,
          access_token: session.access_token,
          refresh_token: session.refresh_token,
          expires_at: session.expires_at,
          platform: session.platform,
          updated_at: new Date(),
        });
        return existingConnection;
      } else {
        // Crear nueva conexión
        const connectionData = {
          id_configuracion,
          oauth_session_id,
          business_account_id,
          access_token: session.access_token,
          refresh_token: session.refresh_token,
          expires_at: session.expires_at,
          platform: session.platform,
          created_at: new Date(),
          updated_at: new Date(),
        };

        return await TikTokConnection.create(connectionData);
      }
    } catch (error) {
      console.error('[TIKTOK_OAUTH] Error en connectBusinessAccount:', error);
      throw new Error(`Error al conectar cuenta de negocio: ${error.message}`);
    }
  }

  /**
   * Refresca el access token usando el refresh token
   */
  static async refreshAccessToken(oauth_session_id) {
    const { TikTokOAuthSession, TikTokConnection } = getTikTokModels();

    try {
      const session = await TikTokOAuthSession.findByPk(oauth_session_id);
      if (!session) {
        throw new Error('Sesión OAuth no encontrada');
      }

      const response = await axios.post(
        `${this.TIKTOK_BASE_URL}/open_api/v1.3/oauth2/refresh_token/`,
        {
          app_id: process.env.TIKTOK_APP_ID,
          app_secret: process.env.TIKTOK_APP_SECRET,
          refresh_token: session.refresh_token,
          grant_type: 'refresh_token',
        },
        {
          headers: {
            'Content-Type': 'application/json',
          },
        }
      );

      if (response.data.code !== 0) {
        throw new Error(`TikTok refresh token error: ${response.data.message}`);
      }

      const { access_token, refresh_token, expires_in } = response.data.data;

      // Actualizar la sesión con los nuevos tokens
      await session.update({
        access_token,
        refresh_token,
        expires_at: new Date(Date.now() + expires_in * 1000),
        updated_at: new Date(),
      });

      // Actualizar también las conexiones relacionadas
      await TikTokConnection.update(
        {
          access_token,
          refresh_token,
          expires_at: new Date(Date.now() + expires_in * 1000),
          updated_at: new Date(),
        },
        {
          where: { oauth_session_id },
        }
      );

      return session;
    } catch (error) {
      console.error('[TIKTOK_OAUTH] Error en refreshAccessToken:', error);
      throw new Error(`Error al refrescar token: ${error.message}`);
    }
  }

  /**
   * Desconecta una cuenta de TikTok de una configuración
   */
  static async disconnectAccount(id_configuracion) {
    const { TikTokOAuthSession, TikTokConnection } = getTikTokModels();

    try {
      const connection = await TikTokConnection.findOne({
        where: { id_configuracion },
      });

      if (!connection) {
        throw new Error(
          'No se encontró una conexión de TikTok para esta configuración'
        );
      }

      // Eliminar la conexión
      await connection.destroy();

      // Opcionalmente, también eliminar la sesión OAuth si no tiene más conexiones
      const otherConnections = await TikTokConnection.count({
        where: { oauth_session_id: connection.oauth_session_id },
      });

      if (otherConnections === 0) {
        await TikTokOAuthSession.destroy({
          where: { id_oauth_session: connection.oauth_session_id },
        });
      }

      return true;
    } catch (error) {
      console.error('[TIKTOK_OAUTH] Error en disconnectAccount:', error);
      throw new Error(`Error al desconectar cuenta: ${error.message}`);
    }
  }

  /**
   * Obtiene una conexión activa por id_configuracion
   */
  static async getConnectionByConfigId(id_configuracion) {
    const { TikTokOAuthSession, TikTokConnection } = getTikTokModels();

    try {
      const connection = await TikTokConnection.findOne({
        where: { id_configuracion },
        include: [
          {
            model: TikTokOAuthSession,
            as: 'oauth_session',
          },
        ],
      });

      return connection;
    } catch (error) {
      console.error('[TIKTOK_OAUTH] Error en getConnectionByConfigId:', error);
      throw new Error(`Error al obtener conexión: ${error.message}`);
    }
  }
}

module.exports = TikTokOAuthService;
