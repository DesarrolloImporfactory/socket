const { DataTypes } = require('sequelize');
const { db } = require('../database/config');

const TikTokNotification = db.define(
  'tiktok_notifications',
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
      allowNull: false,
    },
    type: {
      type: DataTypes.ENUM(
        'campaign_paused',
        'ad_rejected',
        'budget_exhausted',
        'bid_too_low',
        'creative_rejected',
        'conversion_event',
        'general'
      ),
      allowNull: false,
      comment: 'Tipo de notificación',
    },
    message: {
      type: DataTypes.TEXT,
      allowNull: false,
      comment: 'Mensaje de la notificación',
    },
    event_data: {
      type: DataTypes.TEXT,
      allowNull: true,
      comment: 'Datos adicionales del evento en JSON',
    },
    read: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
      comment: 'Indica si la notificación ha sido leída',
    },
    read_at: {
      type: DataTypes.DATE,
      allowNull: true,
      comment: 'Fecha y hora de lectura',
    },
    created_at: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: DataTypes.NOW,
    },
  },
  {
    tableName: 'tiktok_notifications',
    timestamps: false,
    indexes: [
      {
        fields: ['type'],
      },
      {
        fields: ['read'],
      },
      {
        fields: ['created_at'],
      },
    ],
  }
);

module.exports = TikTokNotification;
