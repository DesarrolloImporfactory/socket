const { DataTypes } = require('sequelize');
const { db } = require('../database/config');

const ShopifyConfiguraciones = db.define(
  'shopify_configuraciones',
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    id_configuracion: {
      type: DataTypes.INTEGER,
      allowNull: false,
      unique: true,
    },
    shop_domain: {
      type: DataTypes.STRING(255),
      allowNull: false,
      unique: true,
    },
    access_token: { type: DataTypes.STRING(500), allowNull: true },
    webhook_secret: { type: DataTypes.STRING(255), allowNull: false },

    /* Envío automático de recuperación */
    envio_automatico: { type: DataTypes.TINYINT, defaultValue: 0 },

    /* Configuración de la plantilla de recuperación */
    nombre_template_recuperacion: {
      type: DataTypes.STRING(255),
      allowNull: true,
    },
    parametros_json: { type: DataTypes.TEXT, allowNull: true },
    body_text: { type: DataTypes.TEXT, allowNull: true },
    language_code: { type: DataTypes.STRING(10), defaultValue: 'es' },

    tiempo_espera_horas: { type: DataTypes.INTEGER, defaultValue: 1 },
    prefijo_pais: { type: DataTypes.STRING(5), defaultValue: '593' },
    activo: { type: DataTypes.TINYINT, defaultValue: 1 },
  },
  {
    tableName: 'shopify_configuraciones',
    timestamps: true,
    underscored: true,
  },
);

module.exports = ShopifyConfiguraciones;
