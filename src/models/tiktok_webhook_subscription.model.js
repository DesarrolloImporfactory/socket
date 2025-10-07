const { DataTypes } = require('sequelize');
const { db } = require('../database/config');

const TikTokWebhookSubscription = db.define(
  'tiktok_webhook_subscriptions',
  {
    id: {
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
    subscription_id: {
      type: DataTypes.STRING(100),
      allowNull: false,
      unique: true,
      comment: 'ID de la suscripción en TikTok',
    },
    event_types: {
      type: DataTypes.TEXT,
      allowNull: false,
      comment: 'JSON con los tipos de eventos suscritos',
    },
    callback_url: {
      type: DataTypes.STRING(500),
      allowNull: false,
      comment: 'URL del callback para recibir eventos',
    },
    status: {
      type: DataTypes.ENUM('active', 'inactive', 'cancelled', 'failed'),
      allowNull: false,
      defaultValue: 'active',
      comment: 'Estado de la suscripción',
    },
    last_event_received: {
      type: DataTypes.DATE,
      allowNull: true,
      comment: 'Fecha del último evento recibido',
    },
    events_received_count: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
      comment: 'Contador de eventos recibidos',
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
    tableName: 'tiktok_webhook_subscriptions',
    timestamps: false,
    indexes: [
      {
        fields: ['id_configuracion'],
      },
      {
        fields: ['subscription_id'],
        unique: true,
      },
      {
        fields: ['status'],
      },
      {
        fields: ['callback_url'],
      },
    ],
  }
);

module.exports = TikTokWebhookSubscription;
