const { DataTypes } = require('sequelize');
const { db } = require('../database/config');

const ClientesChatCenter = db.define(
  'clientes_chat_center',
  {
    id: {
      type: DataTypes.BIGINT.UNSIGNED,
      allowNull: false,
      autoIncrement: true,
      primaryKey: true,
    },
    id_plataforma: {
      type: DataTypes.BIGINT.UNSIGNED,
      allowNull: true, // En la tabla permite NULL
      references: { model: 'plataformas', key: 'id_plataforma' },
    },
    id_configuracion: {
      type: DataTypes.BIGINT, // No es UNSIGNED en la tabla
      allowNull: true,
      // references opcional si existe FK real
    },
    id_etiqueta: {
      type: DataTypes.INTEGER,
      allowNull: true,
      defaultValue: null,
    },
    uid_cliente: {
      type: DataTypes.STRING(255),
      allowNull: true,
      defaultValue: null,
    },
    nombre_cliente: {
      type: DataTypes.STRING(255),
      allowNull: true,
      defaultValue: null,
    },
    apellido_cliente: {
      type: DataTypes.STRING(255),
      allowNull: true,
      defaultValue: null,
    },
    email_cliente: {
      type: DataTypes.STRING(255),
      allowNull: true,
      defaultValue: null,
      validate: { isEmail: true },
    },
    celular_cliente: {
      type: DataTypes.STRING(255),
      allowNull: true,
      defaultValue: null,
    },
    imagePath: {
      type: DataTypes.STRING(300),
      allowNull: true,
      defaultValue: null,
    },
    mensajes_por_dia_cliente: {
      type: DataTypes.BIGINT,
      allowNull: false,
      defaultValue: 0,
    },
    estado_cliente: {
      type: DataTypes.TINYINT,
      allowNull: false,
      defaultValue: 1,
    },
    created_at: {
      type: DataTypes.DATE,
      allowNull: true,
      defaultValue: null,
    },
    updated_at: {
      type: DataTypes.DATE,
      allowNull: true,
      defaultValue: null,
    },
    deleted_at: {
      type: DataTypes.DATE,
      allowNull: true,
      defaultValue: null,
    },
    chat_cerrado: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
    },
    bot_openia: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
    },
    id_departamento: {
      type: DataTypes.INTEGER,
      allowNull: true,
      defaultValue: null,
    },
    id_encargado: {
      type: DataTypes.INTEGER,
      allowNull: true,
      defaultValue: null,
    },
    pedido_confirmado: {
      type: DataTypes.INTEGER,
      allowNull: true,
      defaultValue: 0,
    },
  },
  {
    tableName: 'clientes_chat_center',
    timestamps: false,
    freezeTableName: true,
  }
);

module.exports = ClientesChatCenter;
