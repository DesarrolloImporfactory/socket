const { DataTypes } = require('sequelize');
const { db } = require('../database/config');

const CoberturaLaar = db.define(
  'cobertura_laar',
  {
    id_cobertura: {
      type: DataTypes.BIGINT.UNSIGNED,
      allowNull: false,
      primaryKey: true,
    },
    tipo_cobertura: {
      type: DataTypes.STRING(100),
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

    id_matriz: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
  },
  {
    timestamps: false,
    tableName: 'cobertura_laar',
    freezeTableName: true,
  }
);

module.exports = CoberturaLaar;
