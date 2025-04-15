const { DataTypes } = require('sequelize');
const { db } = require('../database/config');

const ClientesChatCenter = db.define(
  'openai_assistants',
  {
    id: {
      type: DataTypes.INTEGER.UNSIGNED,
      allowNull: false,
      autoIncrement: true,
      primaryKey: true,
    },
    id_plataforma: {
      type: DataTypes.INTEGER.UNSIGNED,
      allowNull: false,
      references: {
        model: 'plataformas',
        key: 'id_plataforma',
      },
    },
    tipo: {
      type: DataTypes.STRING(25),
      allowNull: true,
      defaultValue: null,
    },
    nombre_bot: {
      type: DataTypes.STRING(100),
      allowNull: true,
      defaultValue: null,
    },
    assistant_id: {
      type: DataTypes.STRING(100),
      allowNull: true,
      defaultValue: null,
    },
    activo: {
      type: DataTypes.TINYINT(1),
      allowNull: true,
      defaultValue: 1,
    },
    fecha_registro: {
      type: DataTypes.DATE,
      allowNull: true,
      defaultValue: null,
    },
    prompt: {
      type: DataTypes.STRING(1000),
      allowNull: false,
      defaultValue: null,
    },
  },
  {
    tableName: 'openai_assistants',
    timestamps: false,
    freezeTableName: true,
  }
);

module.exports = ClientesChatCenter;
