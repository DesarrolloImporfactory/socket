const { DataTypes } = require('sequelize');
const { db } = require('../database/config');

const Departamentos_chat_center = db.define(
  'departamentos_chat_center',
  {
    id_departamento: {
      type: DataTypes.BIGINT,
      autoIncrement: true,
      primaryKey: true,
      allowNull: false,
    },
    id_usuario: {
      type: DataTypes.BIGINT,
      allowNull: false,
    },
    id_configuracion: {
      type: DataTypes.BIGINT,
      allowNull: false,
    },
    nombre_departamento: {
      type: DataTypes.STRING(250),
      allowNull: false,
    },
    color: {
      type: DataTypes.STRING(100),
      allowNull: false,
    },
    mensaje_saludo: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
  },
  {
    sequelize: db,
    tableName: 'departamentos_chat_center',
    timestamps: false,
    freezeTableName: true,
  }
);

module.exports = Departamentos_chat_center;
