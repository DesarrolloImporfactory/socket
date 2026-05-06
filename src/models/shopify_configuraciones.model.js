const { DataTypes } = require('sequelize');
const { db } = require('../database/config');

const ShopifyConfiguraciones = db.define(
  'shopify_configuraciones',
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    id_configuracion: { type: DataTypes.INTEGER, allowNull: false },
    shop_domain: { type: DataTypes.STRING(255), allowNull: false },
    access_token: { type: DataTypes.STRING(500) },
    webhook_secret: { type: DataTypes.STRING(255), allowNull: false },
    id_template_recuperacion: { type: DataTypes.INTEGER },
    tiempo_espera_horas: { type: DataTypes.INTEGER, defaultValue: 1 },
    prefijo_pais: { type: DataTypes.STRING(5), defaultValue: '593' },
    activo: { type: DataTypes.TINYINT, defaultValue: 1 },
  },
  { tableName: 'shopify_configuraciones', timestamps: true, underscored: true },
);

module.exports = ShopifyConfiguraciones;
