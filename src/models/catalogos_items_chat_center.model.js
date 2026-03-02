const { DataTypes } = require('sequelize');
const { db } = require('../database/config');

const CatalogosItemsChatCenter = db.define(
  'catalogos_items_chat_center',
  {
    id: {
      type: DataTypes.INTEGER,
      autoIncrement: true,
      primaryKey: true,
    },
    id_catalogo: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: {
        model: 'catalogos_chat_center',
        key: 'id',
      },
      onUpdate: 'CASCADE',
      onDelete: 'CASCADE',
    },
    id_producto: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: {
        model: 'productos_chat_center',
        key: 'id',
      },
      onUpdate: 'CASCADE',
      onDelete: 'CASCADE',
    },
    orden: {
      type: DataTypes.INTEGER,
      defaultValue: 0,
    },
    fecha_creacion: {
      type: DataTypes.DATE,
      defaultValue: DataTypes.NOW,
    },
  },
  {
    tableName: 'catalogos_items_chat_center',
    timestamps: false,
  },
);

module.exports = CatalogosItemsChatCenter;
