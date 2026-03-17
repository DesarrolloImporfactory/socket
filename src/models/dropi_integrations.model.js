const { DataTypes } = require('sequelize');
const { db } = require('../database/config');

const DropiIntegrations = db.define(
  'dropi_integrations',
  {
    id: {
      type: DataTypes.BIGINT.UNSIGNED,
      allowNull: false,
      autoIncrement: true,
      primaryKey: true,
    },

    id_configuracion: {
      type: DataTypes.BIGINT.UNSIGNED,
      allowNull: true,
    },

    id_usuario: {
      type: DataTypes.BIGINT.UNSIGNED,
      allowNull: true,
    },

    store_name: {
      type: DataTypes.STRING(150),
      allowNull: false,
    },

    country_code: {
      type: DataTypes.STRING(10),
      allowNull: false,
    },

    integration_key_enc: {
      type: DataTypes.TEXT,
      allowNull: false,
    },

    integration_key_last4: {
      type: DataTypes.STRING(4),
      allowNull: true,
      defaultValue: null,
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

    sync_stock: {
      type: DataTypes.TINYINT,
      allowNull: false,
      defaultValue: 0,
    },

    sync_sale_price: {
      type: DataTypes.TINYINT,
      allowNull: false,
      defaultValue: 0,
    },

    sync_suggested_price: {
      type: DataTypes.TINYINT,
      allowNull: false,
      defaultValue: 0,
    },
  },
  {
    tableName: 'dropi_integrations',
    timestamps: false,
    freezeTableName: true,
    indexes: [
      {
        name: 'uq_dropi_integrations',
        unique: true,
        fields: ['id_configuracion', 'store_name', 'deleted_at'],
      },
      {
        name: 'idx_dropi_integrations_config',
        fields: ['id_configuracion'],
      },
      {
        name: 'idx_dropi_integrations_country',
        fields: ['country_code'],
      },
    ],
  },
);

module.exports = DropiIntegrations;
