const { DataTypes } = require('sequelize');
const { db } = require('../database/config');

const CoberturaGintracom = db.define(
  'cobertura_gintracom',
  {
    id_cobertura: {
      type: DataTypes.INTEGER,
      allowNull: false,
      primaryKey: true,
    },
    trayecto: {
      type: DataTypes.STRING(10),
      allowNull: false,
    },
    costo: {
      type: DataTypes.DOUBLE,
      allowNull: false,
    },
    precio: {
      type: DataTypes.DOUBLE,
      allowNull: false,
    },
    precio_especial1: {
      type: DataTypes.DOUBLE,
      allowNull: false,
    },
    precio_especial2: {
      type: DataTypes.DOUBLE,
      allowNull: false,
    },
  },
  {
    timestamps: false,
    tableName: 'cobertura_gintracom',
    freezeTableName: true,
  }
);

module.exports = CoberturaGintracom;
