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
      allowNull: false,
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
      type: DataTypes.STRING(4), // en tabla es CHAR(4), esto mapea bien
      allowNull: true,
      defaultValue: null,
    },

    is_active: {
      type: DataTypes.TINYINT, // se alinea con tinyint(1)
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
  }
);

module.exports = DropiIntegrations;
