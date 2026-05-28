const { DataTypes } = require('sequelize');
const { db } = require('../database/config');

const ShopifyCarritosAbandonados = db.define(
  'shopify_carritos_abandonados',
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    id_configuracion: { type: DataTypes.INTEGER, allowNull: false },
    id_cliente: { type: DataTypes.INTEGER },
    shop_domain: { type: DataTypes.STRING(255), allowNull: false },
    source: {
      type: DataTypes.ENUM(
        'shopify_checkout',
        'releasit_form',
        'custom_landing',
      ),
      defaultValue: 'shopify_checkout',
    },
    checkout_token: { type: DataTypes.STRING(255), allowNull: false },
    checkout_id: { type: DataTypes.BIGINT, allowNull: false },
    email: { type: DataTypes.STRING(255) },
    phone_raw: { type: DataTypes.STRING(50) },
    phone_normalizado: { type: DataTypes.STRING(50) },
    nombre_cliente: { type: DataTypes.STRING(100) },
    apellido_cliente: { type: DataTypes.STRING(100) },
    total_price: { type: DataTypes.DECIMAL(12, 2), defaultValue: 0 },
    currency: { type: DataTypes.STRING(10), defaultValue: 'USD' },
    abandoned_checkout_url: { type: DataTypes.TEXT },
    line_items: {
      type: DataTypes.JSON,
      get() {
        const raw = this.getDataValue('line_items');
        if (!raw) return [];
        if (typeof raw === 'string') {
          try {
            return JSON.parse(raw);
          } catch {
            return [];
          }
        }
        return raw;
      },
    },
    shipping_address: {
      type: DataTypes.JSON,
      get() {
        const raw = this.getDataValue('shipping_address');
        if (!raw) return null;
        if (typeof raw === 'string') {
          try {
            return JSON.parse(raw);
          } catch {
            return null;
          }
        }
        return raw;
      },
    },
    recuperado: { type: DataTypes.TINYINT, defaultValue: 0 },
    mensaje_enviado: { type: DataTypes.TINYINT, defaultValue: 0 },
    fecha_envio_mensaje: { type: DataTypes.DATE },
    shopify_created_at: { type: DataTypes.DATE },
    shopify_updated_at: { type: DataTypes.DATE },
  },
  {
    tableName: 'shopify_carritos_abandonados',
    timestamps: true,
    underscored: true,
  },
);

module.exports = ShopifyCarritosAbandonados;
