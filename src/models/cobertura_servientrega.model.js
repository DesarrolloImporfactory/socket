const { DataTypes } = require('sequelize');
const { db } = require('../database/config');

const CoberturaServientrega = db.define(
  'cobertura_servientrega',
  {
    id_cobertura: {
      type: DataTypes.INTEGER,
      allowNull: false,
      primaryKey: true,
    },
    tipo_cobertura: {
      type: DataTypes.STRING(255),
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
  },
  {
    timestamps: false,
    tableName: 'cobertura_servientrega',
    freezeTableName: true,
  }
);

module.exports = CoberturaServientrega;
