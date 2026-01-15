const { DataTypes } = require('sequelize');
const { db } = require('../database/config');

const HistorialEncargadosInstagram = db.define(
  'historial_encargados_instagram',
  {
    id: {
      type: DataTypes.BIGINT.UNSIGNED,
      allowNull: false,
      autoIncrement: true,
      primaryKey: true,
    },
    id_instagram_conversation: {
      type: DataTypes.BIGINT,
      allowNull: false,
    },
    id_departamento_asginado: {
      type: DataTypes.BIGINT,
      allowNull: true,
    },
    id_encargado_anterior: {
      type: DataTypes.INTEGER,
      allowNull: true,
      defaultValue: null,
    },
    id_encargado_nuevo: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    motivo: {
      type: DataTypes.STRING(1000),
      allowNull: true,
      defaultValue: null,
    },
    fecha_registro: {
      type: DataTypes.DATE,
      allowNull: true,
      defaultValue: db.literal('CURRENT_TIMESTAMP'),
    },
  },
  {
    tableName: 'historial_encargados_instagram',
    timestamps: false,
    freezeTableName: true,
  }
);

module.exports = HistorialEncargadosInstagram;
