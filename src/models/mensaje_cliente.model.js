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
      allowNull: true,
      // references opcional: si existe FK real, déjalo; si no, quítalo
      references: { model: 'plataformas', key: 'id_plataforma' },
    },
    // En la tabla NO aparece como UNSIGNED
    id_configuracion: {
      type: DataTypes.BIGINT,
      allowNull: true,
      // references: { model: 'configuraciones', key: 'id' }, // activa solo si coincide con tu FK real
    },
    id_cliente: {
      type: DataTypes.BIGINT.UNSIGNED,
      allowNull: false,
      references: { model: 'clientes_chat_center', key: 'id' },
    },
    id_automatizador: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
    mid_mensaje: {
      type: DataTypes.STRING(100),
      allowNull: true,
      defaultValue: null,
    },
    // En la tabla es NULLABLE con default 'text'
    tipo_mensaje: {
      type: DataTypes.STRING(255),
      allowNull: true,
      defaultValue: 'text',
    },
    // NOT NULL, sin default
    rol_mensaje: {
      type: DataTypes.BIGINT,
      allowNull: false,
    },
    celular_recibe: {
      type: DataTypes.STRING(250),
      allowNull: true,
      defaultValue: null,
    },
    // Campo presente en la tabla y faltaba en el modelo
    responsable: {
      type: DataTypes.STRING(100),
      allowNull: true,
      defaultValue: null,
    },
    // Campo presente en la tabla y faltaba en el modelo
    uid_whatsapp: {
      type: DataTypes.STRING(50),
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
    // En la tabla es VARCHAR(4000)
    ruta_archivo: {
      type: DataTypes.STRING(4000),
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
      defaultValue: DataTypes.NOW, // CURRENT_TIMESTAMP
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
    // En la tabla aparece como NULLable; default 0
    visto: {
      type: DataTypes.TINYINT,
      allowNull: true,
      defaultValue: 0,
    },
    notificacion_estado: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
    },
  },
  {
    tableName: 'mensajes_clientes',
    timestamps: false,
    freezeTableName: true,
    underscored: false,
  }
);

module.exports = MensajesClientes;
