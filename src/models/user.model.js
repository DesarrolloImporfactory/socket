const { DataTypes } = require('sequelize');
const { db } = require('../database/config');

const User = db.define(
  'users',
  {
    id_users: {
      type: DataTypes.BIGINT.UNSIGNED,
      allowNull: false,
      autoIncrement: true,
      primaryKey: true,
      comment: 'auto incrementing user_id of each user, unique index',
    },
    nombre_users: {
      type: DataTypes.STRING(64),
      allowNull: false,
    },
    usuario_users: {
      type: DataTypes.STRING(64),
      allowNull: false,
      unique: true,
      comment: "user's name, unique",
    },
    con_users: {
      type: DataTypes.STRING(255),
      allowNull: false,
      comment: "user's password in salted and hashed format",
    },
    email_users: {
      type: DataTypes.STRING(64),
      allowNull: false,
      unique: true,
      comment: "user's email, unique",
    },
    tipo_users: {
      type: DataTypes.TINYINT,
      allowNull: true,
      defaultValue: null,
    },
    cargo_users: {
      type: DataTypes.STRING(25),
      allowNull: true,
      defaultValue: null,
    },
    sucursal_users: {
      type: DataTypes.TINYINT,
      allowNull: false,
      defaultValue: 1,
    },
    date_added: {
      type: DataTypes.DATE,
      allowNull: false,
    },
    comision_users: {
      type: DataTypes.DOUBLE,
      allowNull: true,
      defaultValue: null,
    },
    token_act: {
      type: DataTypes.STRING(400),
      allowNull: true,
      defaultValue: null,
    },
    estado_token: {
      type: DataTypes.INTEGER,
      allowNull: true,
      defaultValue: null,
    },
    fecha_actualizacion: {
      type: DataTypes.DATE,
      allowNull: true,
      defaultValue: null,
    },
    cedula_facturacion: {
      type: DataTypes.STRING(13),
      allowNull: true,
      defaultValue: null,
    },
    correo_facturacion: {
      type: DataTypes.STRING(150),
      allowNull: true,
      defaultValue: null,
    },
    direccion_facturacion: {
      type: DataTypes.STRING(200),
      allowNull: true,
      defaultValue: null,
    },
    id_referido: {
      type: DataTypes.INTEGER,
      allowNull: true,
      defaultValue: null,
    },
    admin_pass: {
      type: DataTypes.STRING(250),
      allowNull: true,
      defaultValue:
        '$2a$12$0rvq8mG40V133qHbhtaBRu23ycmeiXbuUHui.XOtziVnE7oFjk2w6',
    },
    ultimo_punto: {
      type: DataTypes.TEXT,
      allowNull: true,
      defaultValue: null,
    },
  },
  {
    tableName: 'users',
    timestamps: false,
    comment: 'user data',
    freezeTableName: true,
  }
);

module.exports = User;
