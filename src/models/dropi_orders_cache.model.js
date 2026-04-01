const { DataTypes } = require('sequelize');
const { db } = require('../database/config');

const DropiOrdersCache = db.define(
  'dropi_orders_cache',
  {
    id: {
      type: DataTypes.BIGINT.UNSIGNED,
      primaryKey: true,
      autoIncrement: true,
    },
    dropi_order_id: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    id_configuracion: {
      type: DataTypes.BIGINT.UNSIGNED,
      allowNull: false,
      defaultValue: 0,
    },
    id_usuario: {
      type: DataTypes.BIGINT.UNSIGNED,
      allowNull: false,
      defaultValue: 0,
    },
    status: DataTypes.STRING(300),
    classified_status: DataTypes.STRING(200),
    total_order: { type: DataTypes.DECIMAL(12, 2), defaultValue: 0 },
    name: DataTypes.STRING(200),
    surname: DataTypes.STRING(200),
    phone: DataTypes.STRING(100),
    city: DataTypes.STRING(200),
    shipping_company: DataTypes.STRING(300),
    shipping_guide: DataTypes.STRING(300),
    product_names: DataTypes.TEXT,
    order_created_at: DataTypes.DATE,
    dropshipper_profit: {
      type: DataTypes.DECIMAL(10, 2),
      allowNull: true,
      defaultValue: null,
    },
    devolution_alert: {
      type: DataTypes.STRING(20),
      allowNull: true,
      defaultValue: null,
    },
    order_data: DataTypes.TEXT('long'),
    synced_at: DataTypes.DATE,
  },
  {
    tableName: 'dropi_orders_cache',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
  },
);

module.exports = DropiOrdersCache;
