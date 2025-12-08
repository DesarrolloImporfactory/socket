const { DataTypes } = require('sequelize');
const { db } = require('../database/config');

const Planes_chat_center = db.define(
  'planes_chat_center',
  {
    id_plan: {
      type: DataTypes.INTEGER,
      autoIncrement: true,
      primaryKey: true,
      allowNull: false,
    },
    activo: {
      type: DataTypes.INTEGER,
      defaultValue: 1,
      allowNull: true,
    },
    nombre_plan: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    descripcion_plan: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    precio_plan: {
      type: DataTypes.DECIMAL(10, 2),
      allowNull: false,
    },
    n_conversaciones: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    n_conexiones: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    max_subusuarios: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    max_conexiones: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    duracion_plan: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    id_product_stripe: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    id_price: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    ahorro: {
      type: DataTypes.DECIMAL(10, 2),
      allowNull: false,
    },
  },
  {
    sequelize: db,
    tableName: 'planes_chat_center',
    timestamps: false,
    freezeTableName: true,
  }
);

module.exports = Planes_chat_center;
