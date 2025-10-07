const { DataTypes } = require('sequelize');
const { db } = require('../database/config');

const TikTokOAuthSession = db.define(
  'tiktok_oauth_sessions',
  {
    id_oauth_session: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
      allowNull: false,
    },
    id_configuracion: {
      type: DataTypes.INTEGER,
      allowNull: false,
      comment: 'ID de la configuración del usuario',
    },
    access_token: {
      type: DataTypes.TEXT,
      allowNull: false,
      comment: 'Token de acceso de TikTok',
    },
    refresh_token: {
      type: DataTypes.TEXT,
      allowNull: false,
      comment: 'Token de refresco de TikTok',
    },
    platform: {
      type: DataTypes.ENUM('web', 'desktop', 'android', 'ios'),
      allowNull: false,
      defaultValue: 'web',
      comment: 'Plataforma desde la cual se autenticó',
    },
    redirect_uri: {
      type: DataTypes.STRING(500),
      allowNull: false,
      comment: 'URI de redirección utilizada en el OAuth',
    },
    advertiser_ids: {
      type: DataTypes.TEXT,
      allowNull: true,
      comment: 'JSON con los IDs de las cuentas publicitarias del usuario',
    },
    expires_at: {
      type: DataTypes.DATE,
      allowNull: false,
      comment: 'Fecha de expiración del token',
    },
    state: {
      type: DataTypes.ENUM('active', 'expired', 'revoked'),
      allowNull: false,
      defaultValue: 'active',
      comment: 'Estado de la sesión OAuth',
    },
    created_at: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: DataTypes.NOW,
    },
    updated_at: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: DataTypes.NOW,
    },
  },
  {
    tableName: 'tiktok_oauth_sessions',
    timestamps: false,
    indexes: [
      {
        fields: ['id_configuracion'],
      },
      {
        fields: ['expires_at'],
      },
      {
        fields: ['state'],
      },
    ],
  }
);

module.exports = TikTokOAuthSession;
