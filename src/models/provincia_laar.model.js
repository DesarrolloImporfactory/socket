const { DataTypes } = require('sequelize');
const { db_2 } = require('../database/config');

const ProvinciaLaar = db_2.define(
  'provincia_laar',
  {
    id_prov: {
      type: DataTypes.BIGINT.UNSIGNED,
      allowNull: false,
      primaryKey: true,
      autoIncrement: true,
    },
    provincia: {
      type: DataTypes.STRING(150),
      allowNull: false,
    },
    codigo_laar: {
      type: DataTypes.STRING(500),
      allowNull: true,
      defaultValue: null,
    },
    codigo_provincia: {
      type: DataTypes.STRING(500),
      allowNull: true,
      defaultValue: null,
    },
    id_pais: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 1,
    },
  },
  {
    tableName: 'provincia_laar',
    timestamps: false,
    freezeTableName: true,
  }
);

module.exports = ProvinciaLaar;
