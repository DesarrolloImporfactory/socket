const { DataTypes } = require('sequelize');
const { db } = require('../database/config');

const ShopifyConnections = db.define(
  'shopify_connections',
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    id_usuario: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    shop_domain: {
      type: DataTypes.STRING(255),
      allowNull: false,
      comment: 'ej: mi-tienda.myshopify.com',
    },
    access_token: {
      type: DataTypes.TEXT,
      allowNull: false,
      comment: 'Token encriptado con cryptoToken',
    },
    scopes: {
      type: DataTypes.STRING(500),
      allowNull: true,
      comment: 'Scopes otorgados por el merchant',
    },
    shop_name: {
      type: DataTypes.STRING(255),
      allowNull: true,
      comment: 'Nombre de la tienda (se llena post-conexión)',
    },
    shop_email: {
      type: DataTypes.STRING(255),
      allowNull: true,
    },
    estado: {
      type: DataTypes.ENUM('activo', 'desconectado', 'error'),
      defaultValue: 'activo',
    },
    ultima_sincronizacion: {
      type: DataTypes.DATE,
      allowNull: true,
    },
  },
  {
    tableName: 'shopify_connections',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
  },
);

module.exports = ShopifyConnections;
