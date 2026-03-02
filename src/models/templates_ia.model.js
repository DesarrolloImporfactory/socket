const { DataTypes } = require('sequelize');
const { db } = require('../database/config');

const TemplatesIA = db.define(
  'templates_ia',
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    nombre: {
      type: DataTypes.STRING(150),
      allowNull: false,
    },
    src_url: {
      type: DataTypes.TEXT,
      allowNull: false,
    },
    descripcion: {
      type: DataTypes.STRING(255),
      allowNull: true,
    },
    categoria: {
      type: DataTypes.STRING(50),
      defaultValue: 'general',
    },
    id_etapa: {
      type: DataTypes.INTEGER,
      allowNull: true,
      defaultValue: null,
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
    tableName: 'templates_ia',
    timestamps: true,
    underscored: true,
  },
);

module.exports = TemplatesIA;
