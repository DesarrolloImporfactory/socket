const { DataTypes } = require('sequelize');
const { db } = require('../database/config');

const TikTokConnection = db.define(
  'tiktok_connections',
  {
    id_connection: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
      allowNull: false,
    },
    id_configuracion: {
      type: DataTypes.INTEGER,
      allowNull: false,
      unique: true,
      comment: 'ID de la configuración del usuario (relación 1:1)',
    },
    oauth_session_id: {
      type: DataTypes.INTEGER,
      allowNull: false,
      comment: 'ID de la sesión OAuth de TikTok',
    },
    business_account_id: {
      type: DataTypes.STRING(100),
      allowNull: false,
      comment: 'ID de la cuenta de negocio de TikTok (advertiser_id)',
    },
    business_account_name: {
      type: DataTypes.STRING(255),
      allowNull: true,
      comment: 'Nombre de la cuenta de negocio',
    },
    access_token: {
      type: DataTypes.TEXT,
      allowNull: false,
      comment: 'Token de acceso actual (duplicado para consultas rápidas)',
    },
    refresh_token: {
      type: DataTypes.TEXT,
      allowNull: false,
      comment: 'Token de refresco actual',
    },
    expires_at: {
      type: DataTypes.DATE,
      allowNull: false,
      comment: 'Fecha de expiración del token actual',
    },
    platform: {
      type: DataTypes.ENUM('web', 'desktop', 'android', 'ios'),
      allowNull: false,
      defaultValue: 'web',
      comment: 'Plataforma desde la cual se conectó',
    },
    status: {
      type: DataTypes.ENUM('active', 'inactive', 'error'),
      allowNull: false,
      defaultValue: 'active',
      comment: 'Estado de la conexión',
    },
    last_sync: {
      type: DataTypes.DATE,
      allowNull: true,
      comment: 'Última sincronización exitosa',
    },
    error_message: {
      type: DataTypes.TEXT,
      allowNull: true,
      comment: 'Último mensaje de error si lo hay',
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
    tableName: 'tiktok_connections',
    timestamps: false,
    indexes: [
      {
        fields: ['id_configuracion'],
        unique: true,
      },
      {
        fields: ['oauth_session_id'],
      },
      {
        fields: ['business_account_id'],
      },
      {
        fields: ['status'],
      },
      {
        fields: ['expires_at'],
      },
    ],
  }
);

module.exports = TikTokConnection;
