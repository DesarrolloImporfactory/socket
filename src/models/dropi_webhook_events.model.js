const { DataTypes } = require('sequelize');
const { db } = require('../database/config');

const DropiWebhookEvents = db.define(
  'dropi_webhook_events',
  {
    id: {
      type: DataTypes.BIGINT.UNSIGNED,
      primaryKey: true,
      autoIncrement: true,
    },

    dropi_order_id: { type: DataTypes.BIGINT, allowNull: true },
    status: { type: DataTypes.STRING(60), allowNull: true },
    supplier_id: { type: DataTypes.BIGINT, allowNull: true },
    shop_id: { type: DataTypes.BIGINT, allowNull: true },

    phone_raw: { type: DataTypes.STRING(60), allowNull: true },
    phone_digits: { type: DataTypes.STRING(20), allowNull: true },

    external_id: { type: DataTypes.STRING(128), allowNull: true },
    shop_order_id: { type: DataTypes.STRING(128), allowNull: true },
    shop_order_number: { type: DataTypes.STRING(128), allowNull: true },

    shipping_company: { type: DataTypes.STRING(100), allowNull: true },
    shipping_guide: { type: DataTypes.STRING(120), allowNull: true },
    sticker: { type: DataTypes.STRING(160), allowNull: true },

    country: { type: DataTypes.STRING(60), allowNull: true },
    state: { type: DataTypes.STRING(60), allowNull: true },
    city: { type: DataTypes.STRING(60), allowNull: true },
    dir: { type: DataTypes.STRING(255), allowNull: true },

    event_hash: { type: DataTypes.CHAR(64), allowNull: false, unique: true },

    payload: { type: DataTypes.JSON, allowNull: false }, // ✅ JSON nativo

    created_at: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: DataTypes.NOW,
    },
  },
  {
    tableName: 'dropi_webhook_events',
    timestamps: false,
  },
);

module.exports = DropiWebhookEvents;
