const { DataTypes } = require('sequelize');
const { db } = require('../database/config');

const GeneracionesIA = db.define(
  'generaciones_ia',
  {
    id: {
      type: DataTypes.BIGINT.UNSIGNED,
      primaryKey: true,
      autoIncrement: true,
    },
    id_usuario: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    id_sub_usuario: {
      type: DataTypes.INTEGER,
      allowNull: true,
      defaultValue: null,
    },
    template_id: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
    id_etapa: {
      type: DataTypes.INTEGER,
      allowNull: true,
      defaultValue: null,
    },
    aspect_ratio: {
      type: DataTypes.STRING(10),
      defaultValue: '1:1',
    },
    description: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    prompt: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    model: {
      type: DataTypes.STRING(100),
      allowNull: true,
    },
    image_url: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    created_at: {
      type: DataTypes.DATE,
      defaultValue: DataTypes.NOW,
    },
  },
  {
    tableName: 'generaciones_ia',
    timestamps: false,
    underscored: true,
  },
);

module.exports = GeneracionesIA;
