const { DataTypes } = require('sequelize');
const { db } = require('../database/config');

const MensajesClientes = db.define(
  'mensajes_clientes',
  {
    id: {
      type: DataTypes.BIGINT.UNSIGNED,
      allowNull: false,
      autoIncrement: true,
      primaryKey: true,
    },
    id_plataforma: {
      type: DataTypes.BIGINT.UNSIGNED,
      allowNull: false,
      references: {
        model: 'plataformas',
        key: 'id_plataforma',
      },
    },
    id_cliente: {
      type: DataTypes.BIGINT.UNSIGNED,
      allowNull: false,
      references: {
        model: 'clientes_chat_center',
        key: 'id',
      },
    },
    mid_mensaje: {
      type: DataTypes.STRING(100),
      allowNull: true,
      defaultValue: null,
    },
    tipo_mensaje: {
      type: DataTypes.STRING(255),
      allowNull: false,
      defaultValue: 'text',
    },
    rol_mensaje: {
      type: DataTypes.BIGINT,
      allowNull: false,
    },
    celular_recibe: {
      type: DataTypes.STRING(250),
      allowNull: true,
      defaultValue: null,
    },
    texto_mensaje: {
      type: DataTypes.TEXT('long'),
      allowNull: true,
      defaultValue: null,
    },
    texto_corregido_mensaje: {
      type: DataTypes.STRING(4000),
      allowNull: true,
      defaultValue: null,
    },
    ruta_archivo: {
      type: DataTypes.STRING(500),
      allowNull: true,
      defaultValue: null,
    },
    calificacion_mensaje: {
      type: DataTypes.TINYINT,
      allowNull: false,
      defaultValue: 0,
    },
    json_mensaje: {
      type: DataTypes.TEXT('long'),
      allowNull: true,
      defaultValue: null,
    },
    json_analytics_mensaje: {
      type: DataTypes.STRING(1000),
      allowNull: true,
      defaultValue: null,
    },
    total_tokens_openai_mensaje: {
      type: DataTypes.BIGINT,
      allowNull: true,
      defaultValue: null,
    },
    apis_mensaje_analytics: {
      type: DataTypes.STRING(255),
      allowNull: true,
      defaultValue: null,
    },
    informacion_suficiente: {
      type: DataTypes.TINYINT,
      allowNull: true,
      defaultValue: 1,
    },
    pregunta_fuera_de_tema: {
      type: DataTypes.TINYINT,
      allowNull: true,
      defaultValue: 0,
    },
    created_at: {
      type: DataTypes.DATE,
      allowNull: true,
      defaultValue: DataTypes.NOW,
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
  },
  {
    tableName: 'mensajes_clientes',
    timestamps: false,
    freezeTableName: true,
  }
);

module.exports = MensajesClientes;
