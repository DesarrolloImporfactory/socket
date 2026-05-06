const { DataTypes } = require('sequelize');
const { db } = require('../database/config');

const Comunidad_chat_center = db.define(
  'comunidades_chat_center',
  {
    id_comunidad: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    nombre: { type: DataTypes.STRING(120), allowNull: false },
    slug: { type: DataTypes.STRING(140), allowNull: false, unique: true },
    activo: { type: DataTypes.TINYINT, defaultValue: 1 },
    total_registros: { type: DataTypes.INTEGER, defaultValue: 0 },
  },
  {
    tableName: 'comunidades_chat_center',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
  },
);

module.exports = Comunidad_chat_center;
