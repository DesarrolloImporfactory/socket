const { DataTypes } = require('sequelize');
const { db } = require('../database/config');

const TikTokWebhookEvent = db.define(
  'tiktok_webhook_events',
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
      allowNull: false,
    },
    event_id: {
      type: DataTypes.STRING(100),
      allowNull: true,
      comment: 'ID único del evento de TikTok',
    },
    event_type: {
      type: DataTypes.ENUM(
        'CAMPAIGN_STATUS_CHANGE',
        'AD_GROUP_STATUS_CHANGE',
        'AD_STATUS_CHANGE',
        'BUDGET_EXHAUSTED',
        'BID_TOO_LOW',
        'CREATIVE_REJECTED',
        'CONVERSION_EVENT',
        'TEST_EVENT',
        'UNKNOWN'
      ),
      allowNull: false,
      comment: 'Tipo de evento del webhook',
    },
    advertiser_id: {
      type: DataTypes.STRING(100),
      allowNull: true,
      comment: 'ID de la cuenta publicitaria',
    },
    campaign_id: {
      type: DataTypes.STRING(100),
      allowNull: true,
      comment: 'ID de la campaña (si aplica)',
    },
    ad_group_id: {
      type: DataTypes.STRING(100),
      allowNull: true,
      comment: 'ID del grupo de anuncios (si aplica)',
    },
    ad_id: {
      type: DataTypes.STRING(100),
      allowNull: true,
      comment: 'ID del anuncio (si aplica)',
    },
    event_data: {
      type: DataTypes.TEXT,
      allowNull: false,
      comment: 'Datos completos del evento en JSON',
    },
    received_at: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: DataTypes.NOW,
      comment: 'Fecha y hora de recepción del evento',
    },
    processed: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
      comment: 'Indica si el evento ha sido procesado',
    },
    processed_at: {
      type: DataTypes.DATE,
      allowNull: true,
      comment: 'Fecha y hora de procesamiento',
    },
    error_message: {
      type: DataTypes.TEXT,
      allowNull: true,
      comment: 'Mensaje de error si el procesamiento falló',
    },
  },
  {
    tableName: 'tiktok_webhook_events',
    timestamps: false,
    indexes: [
      {
        fields: ['event_type'],
      },
      {
        fields: ['advertiser_id'],
      },
      {
        fields: ['received_at'],
      },
      {
        fields: ['processed'],
      },
      {
        fields: ['campaign_id'],
      },
      {
        fields: ['ad_group_id'],
      },
      {
        fields: ['ad_id'],
      },
    ],
  }
);

module.exports = TikTokWebhookEvent;
