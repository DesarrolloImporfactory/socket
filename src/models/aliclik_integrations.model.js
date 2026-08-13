const { DataTypes } = require('sequelize');
const { db } = require('../database/config');

const AliclikIntegrations = db.define(
  'aliclik_integrations',
  {
    id: {
      type: DataTypes.BIGINT.UNSIGNED,
      allowNull: false,
      autoIncrement: true,
      primaryKey: true,
    },

    id_configuracion: {
      type: DataTypes.BIGINT.UNSIGNED,
      allowNull: false,
    },

    store_name: {
      type: DataTypes.STRING(150),
      allowNull: false,
    },

    // Cifrado con utils/cryptoToken (misma llave que Dropi)
    token_enc: {
      type: DataTypes.TEXT,
      allowNull: false,
    },

    token_last4: {
      type: DataTypes.STRING(4),
      allowNull: true,
      defaultValue: null,
    },

    // El token de Aliclik es un JWT con exp (30 días en los que emiten hoy).
    // Se guarda al vincular para poder avisar antes de que caduque: cuando
    // vence, la API responde 401 y la cuenta deja de recibir estados sin que
    // nadie se entere.
    token_exp_at: {
      type: DataTypes.DATE,
      allowNull: true,
      defaultValue: null,
    },

    company_id: {
      type: DataTypes.BIGINT.UNSIGNED,
      allowNull: true,
      defaultValue: null,
    },

    integration_id: {
      type: DataTypes.BIGINT.UNSIGNED,
      allowNull: true,
      defaultValue: null,
    },

    // Segmento de path que el cliente pega en el panel de Aliclik. Autentica
    // el webhook (el payload no trae firma) y resuelve a qué configuración
    // pertenece el evento (el payload no trae companyId).
    webhook_secret: {
      type: DataTypes.STRING(64),
      allowNull: false,
    },

    is_active: {
      type: DataTypes.TINYINT,
      allowNull: false,
      defaultValue: 1,
    },

    deleted_at: {
      type: DataTypes.DATE,
      allowNull: true,
      defaultValue: null,
    },
  },
  {
    tableName: 'aliclik_integrations',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
    freezeTableName: true,
    indexes: [
      // Único y obligatorio: es la clave por la que el webhook resuelve a qué
      // cuenta pertenece cada evento.
      {
        name: 'uq_aliclik_webhook_secret',
        unique: true,
        fields: ['webhook_secret'],
      },
      {
        name: 'uq_aliclik_integrations',
        unique: true,
        fields: ['id_configuracion', 'store_name', 'deleted_at'],
      },
      { name: 'idx_aliclik_integrations_config', fields: ['id_configuracion'] },
    ],
  },
);

module.exports = AliclikIntegrations;
