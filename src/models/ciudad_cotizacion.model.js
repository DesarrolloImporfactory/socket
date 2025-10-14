const { DataTypes } = require('sequelize');
const { db_2 } = require('../database/config');

const CiudadCotizacion = db_2.define(
  'ciudad_cotizacion',
  {
    id_cotizacion: {
      type: DataTypes.INTEGER,
      allowNull: false,
      primaryKey: true,
    },
    provincia: {
      type: DataTypes.STRING(100),
      allowNull: false,
    },
    ciudad: {
      type: DataTypes.STRING(100),
      allowNull: false,
    },
    cobertura_servientrega: {
      type: DataTypes.TINYINT,
      allowNull: true,
      defaultValue: 0,
    },
    cobertura_laar: {
      type: DataTypes.TINYINT,
      allowNull: true,
      defaultValue: 0,
    },
    cobertura_gintracom: {
      type: DataTypes.TINYINT,
      allowNull: true,
      defaultValue: 0,
    },
    trayecto_servientrega: {
      type: DataTypes.STRING(255),
      allowNull: true,
    },
    trayecto_laar: {
      type: DataTypes.STRING(255),
      allowNull: true,
    },
    trayecto_gintracom: {
      type: DataTypes.STRING(255),
      allowNull: true,
    },
    codigo_provincia_servientrega: {
      type: DataTypes.STRING(100),
      allowNull: true,
    },
    codigo_provincia_laar: {
      type: DataTypes.STRING(100),
      allowNull: true,
    },
    codigo_ciudad_laar: {
      type: DataTypes.STRING(100),
      allowNull: true,
    },
    codigo_provincia_gintracom: {
      type: DataTypes.STRING(100),
      allowNull: true,
    },
    codigo_ciudad_gintracom: {
      type: DataTypes.STRING(100),
      allowNull: true,
    },
    codigo_ciudad_servientrega: {
      type: DataTypes.STRING(100),
      allowNull: true,
    },
    id_pais: {
      type: DataTypes.TINYINT,
      allowNull: false,
      defaultValue: 1,
    },
  },
  {
    tableName: 'ciudad_cotizacion',
    timestamps: false,
    freezeTableName: true,
  }
);

module.exports = CiudadCotizacion;
