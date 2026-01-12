const { DataTypes } = require('sequelize');
const { db } = require('../database/config');

const Sub_usuarios_chat_center = db.define(
  'sub_usuarios_chat_center',
  {
    id_sub_usuario: {
      type: DataTypes.INTEGER,
      autoIncrement: true,
      primaryKey: true,
      allowNull: true,
    },
    id_usuario: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    usuario: {
      type: DataTypes.STRING,
      allowNull: false,
      unique: true,
    },
    password: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    email: {
      type: DataTypes.STRING,
      allowNull: false,
      unique: true,
    },
    admin_pass: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    nombre_encargado: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    rol: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    activar_cotizacion: {
      type: DataTypes.TINYINT,
      allowNull: false,
      defaultValue: 0,
    },
  },
  {
    sequelize: db,
    tableName: 'sub_usuarios_chat_center',
    timestamps: false,
    freezeTableName: true,
  }
);

module.exports = Sub_usuarios_chat_center;
