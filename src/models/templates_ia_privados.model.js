const { DataTypes } = require('sequelize');
const { db } = require('../database/config');

const TemplatesIAPrivados = db.define(
  'templates_ia_privados',
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    id_usuario: { type: DataTypes.INTEGER, allowNull: false },
    nombre: { type: DataTypes.STRING(150), allowNull: false },
    src_url: { type: DataTypes.TEXT, allowNull: false },
    id_etapa: { type: DataTypes.INTEGER, allowNull: true },
    activo: { type: DataTypes.TINYINT, defaultValue: 1 },
    created_at: { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
    updated_at: { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
  },
  {
    tableName: 'templates_ia_privados',
    timestamps: false,
  },
);

module.exports = TemplatesIAPrivados;
