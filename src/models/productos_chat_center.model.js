const { DataTypes } = require('sequelize');
const { db } = require('../database/config');

const ProductosChatCenter = db.define(
  'productos_chat_center',
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
      type: DataTypes.STRING(255),
      allowNull: false,
    },
    descripcion: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    tipo: {
      type: DataTypes.STRING(50),
      allowNull: false,
    },
    precio: {
      type: DataTypes.DECIMAL(10, 2),
      allowNull: false,
    },
    duracion: {
      type: DataTypes.INTEGER,
      defaultValue: 0,
    },
    imagen_url: {
      type: DataTypes.STRING(512),
      allowNull: true,
    },
    video_url: {
      type: DataTypes.STRING(512),
      allowNull: true,
    },
    stock: {
      type: DataTypes.INTEGER,
      defaultValue: 0,
    },
    eliminado: {
      type: DataTypes.INTEGER,
      defaultValue: 0,
    },
    id_categoria: {
      type: DataTypes.INTEGER,
      allowNull: true,
      references: {
        model: 'categorias_chat_center',
        key: 'id',
      },
      onUpdate: 'CASCADE',
      onDelete: 'SET NULL',
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
    tableName: 'productos_chat_center',
    timestamps: false,
  }
);

module.exports = ProductosChatCenter;
