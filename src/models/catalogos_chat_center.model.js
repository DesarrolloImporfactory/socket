const { DataTypes } = require('sequelize');
const { db } = require('../database/config');

const CatalogosChatCenter = db.define(
  'catalogos_chat_center',
  {
    id: {
      type: DataTypes.INTEGER,
      autoIncrement: true,
      primaryKey: true,
    },
    id_configuracion: {
      type: DataTypes.BIGINT.UNSIGNED,
      allowNull: false,
    },
    nombre_interno: {
      type: DataTypes.STRING(255),
      allowNull: false,
    },
    titulo_publico: {
      type: DataTypes.STRING(255),
      allowNull: true,
    },
    descripcion_publica: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    slug: {
      type: DataTypes.STRING(120),
      allowNull: false,
      unique: true,
    },
    modo_visibilidad: {
      type: DataTypes.ENUM('PUBLIC_ONLY', 'PRIVATE_ONLY', 'BOTH'),
      allowNull: false,
      defaultValue: 'BOTH',
    },
    settings_json: {
      type: DataTypes.BLOB, // equivalente a longtext/bin
      allowNull: true,
    },
    eliminado: {
      type: DataTypes.INTEGER,
      defaultValue: 0,
    },
    fecha_creacion: {
      type: DataTypes.DATE,
      defaultValue: DataTypes.NOW,
    },
    fecha_actualizacion: {
      type: DataTypes.DATE,
      defaultValue: DataTypes.NOW,
    },
  },
  {
    tableName: 'catalogos_chat_center',
    timestamps: false,
  },
);

module.exports = CatalogosChatCenter;
