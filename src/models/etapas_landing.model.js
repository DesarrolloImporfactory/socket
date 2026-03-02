const { DataTypes } = require('sequelize');
const { db } = require('../database/config');

const EtapasLanding = db.define(
  'etapas_landing',
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    nombre: {
      type: DataTypes.STRING(100),
      allowNull: false,
    },
    slug: {
      type: DataTypes.STRING(50),
      allowNull: false,
      unique: true,
    },
    descripcion: {
      type: DataTypes.STRING(255),
      allowNull: true,
    },
    prompt: {
      type: DataTypes.TEXT,
      allowNull: false,
    },
    es_obligatoria: {
      type: DataTypes.TINYINT,
      allowNull: false,
      defaultValue: 0,
    },
    orden: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
    },
    activo: {
      type: DataTypes.TINYINT,
      allowNull: false,
      defaultValue: 1,
    },
  },
  {
    tableName: 'etapas_landing',
    timestamps: true,
    underscored: true,
  },
);

module.exports = EtapasLanding;
