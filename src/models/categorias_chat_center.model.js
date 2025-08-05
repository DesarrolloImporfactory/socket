const { DataTypes } = require('sequelize');
const { db } = require('../database/config');

const CategoriasChatCenter = db.define(
  'categorias_chat_center',
  {
    id: {
      type: DataTypes.INTEGER,
      autoIncrement: true,
      primaryKey: true,
    },
    id_configuracion: {
      type: DataTypes.BIGINT.UNSIGNED,
      allowNull: false,
    },
    nombre: {
      type: DataTypes.STRING(100),
      allowNull: false,
    },
    descripcion: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    fecha_creacion: {
      type: DataTypes.DATE,
      defaultValue: DataTypes.NOW,
    },
    fecha_actualizacion: {
      type: DataTypes.DATE,
      defaultValue: DataTypes.NOW,
    },
  },
  {
    tableName: 'categorias_chat_center',
    timestamps: false,
  }
);

module.exports = CategoriasChatCenter;
