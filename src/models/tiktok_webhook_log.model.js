const { DataTypes } = require('sequelize');
const { db } = require('../database/config');

const TikTokWebhookLog = db.define(
  'tiktok_webhook_logs',
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
      allowNull: false,
    },
    request_method: {
      type: DataTypes.ENUM('GET', 'POST', 'PUT', 'DELETE'),
      allowNull: false,
      comment: 'Método HTTP de la petición',
    },
    request_url: {
      type: DataTypes.STRING(500),
      allowNull: false,
      comment: 'URL de la petición',
    },
    request_headers: {
      type: DataTypes.TEXT,
      allowNull: true,
      comment: 'Headers de la petición en JSON',
    },
    request_body: {
      type: DataTypes.TEXT,
      allowNull: true,
      comment: 'Body de la petición (si aplica)',
    },
    request_query: {
      type: DataTypes.TEXT,
      allowNull: true,
      comment: 'Query parameters en JSON',
    },
    source_ip: {
      type: DataTypes.STRING(45),
      allowNull: true,
      comment: 'IP de origen de la petición',
    },
    user_agent: {
      type: DataTypes.STRING(500),
      allowNull: true,
      comment: 'User agent del cliente',
    },
    response_status: {
      type: DataTypes.INTEGER,
      allowNull: true,
      comment: 'Código de estado HTTP de respuesta',
    },
    response_body: {
      type: DataTypes.TEXT,
      allowNull: true,
      comment: 'Respuesta enviada',
    },
    processing_time_ms: {
      type: DataTypes.INTEGER,
      allowNull: true,
      comment: 'Tiempo de procesamiento en milisegundos',
    },
    is_tiktok_request: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
      comment: 'Indica si la petición viene de TikTok',
    },
    is_test_request: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
      comment: 'Indica si es una petición de prueba',
    },
    error_message: {
      type: DataTypes.TEXT,
      allowNull: true,
      comment: 'Mensaje de error si lo hay',
    },
    received_at: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: DataTypes.NOW,
      comment: 'Fecha y hora de recepción',
    },
  },
  {
    tableName: 'tiktok_webhook_logs',
    timestamps: false,
    indexes: [
      {
        fields: ['request_method'],
      },
      {
        fields: ['source_ip'],
      },
      {
        fields: ['received_at'],
      },
      {
        fields: ['is_tiktok_request'],
      },
      {
        fields: ['is_test_request'],
      },
      {
        fields: ['response_status'],
      },
    ],
  }
);

module.exports = TikTokWebhookLog;
