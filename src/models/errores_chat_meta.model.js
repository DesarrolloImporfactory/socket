// models/ErroresChatMeta.js
const { DataTypes } = require('sequelize');
const { db } = require('../database/config');

const ErroresChatMeta = db.define(
  'errores_chat_meta',
  {
    id: {
      type: DataTypes.BIGINT, // en la captura no aparece UNSIGNED
      allowNull: false,
      autoIncrement: true,
      primaryKey: true,
    },
    id_wamid_mensaje: {
      type: DataTypes.STRING(250),
      allowNull: false,
    },
    codigo_error: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    mensaje_error: {
      type: DataTypes.STRING(250),
      allowNull: false,
    },
    fecha_error: {
      type: DataTypes.DATE, // mapea DATETIME
      allowNull: false,
      defaultValue: DataTypes.NOW, // CURRENT_TIMESTAMP
    },
  },
  {
    tableName: 'errores_chat_meta',
    timestamps: false, // la tabla no tiene created_at/updated_at
    freezeTableName: true,
    underscored: false,
    indexes: [
      // útil para consultar por wamid y por código
      { fields: ['id_wamid_mensaje'] },
      { fields: ['codigo_error'] },
    ],
  }
);

module.exports = ErroresChatMeta;
