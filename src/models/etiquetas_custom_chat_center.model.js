const { DataTypes } = require('sequelize');
const { db } = require('../database/config');

const EtiquetasCustomChatCenter = db.define(
  'etiquetas_custom_chat_center',
  {
    id: {
      type: DataTypes.BIGINT.UNSIGNED,
      primaryKey: true,
      autoIncrement: true,
    },
    id_configuracion: {
      type: DataTypes.BIGINT.UNSIGNED,
      allowNull: false,
    },
    tipo: {
      type: DataTypes.ENUM('asesor', 'ciclo'),
      allowNull: false,
    },
    nombre: {
      type: DataTypes.STRING(120),
      allowNull: false,
    },
    created_at: {
      type: DataTypes.DATE,
      defaultValue: DataTypes.NOW,
    },
    deleted_at: {
      type: DataTypes.DATE,
      defaultValue: null,
    },
  },
  {
    tableName: 'etiquetas_custom_chat_center',
    timestamps: false,
    paranoid: false, // manejamos soft-delete manualmente
  },
);

module.exports = EtiquetasCustomChatCenter;
