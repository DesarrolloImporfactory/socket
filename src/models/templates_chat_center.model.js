const { DataTypes } = require('sequelize');
const { db } = require('../database/config');

const TemplatesChatCenter = db.define(
  'templates_chat_center',
  {
    id_template: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    id_plataforma: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    id_configuracion: {
      type: DataTypes.BIGINT,
      allowNull: false,
    },
    atajo: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    mensaje: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    ruta_archivo: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
  },
  {
    tableName: 'templates_chat_center',
    timestamps: false,
    freezeTableName: true,
  },
);

module.exports = TemplatesChatCenter;
