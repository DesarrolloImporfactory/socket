const { DataTypes } = require('sequelize');
const { db } = require('../database/config');

const MensajesClientes = db.define(
  'mensajes_clientes',
  {
    id: {
      type: DataTypes.BIGINT.UNSIGNED,
      primaryKey: true,
      autoIncrement: true,
    },

    id_plataforma: { type: DataTypes.BIGINT.UNSIGNED, allowNull: true },
    id_configuracion: { type: DataTypes.BIGINT, allowNull: true },

    id_cliente: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },

    // ✅ NUEVOS (BD)
    source: {
      type: DataTypes.ENUM('wa', 'ms', 'ig'),
      allowNull: false,
      defaultValue: 'wa',
    },
    page_id: { type: DataTypes.STRING(64), allowNull: true },

    id_automatizador: { type: DataTypes.INTEGER, allowNull: true },
    mid_mensaje: { type: DataTypes.STRING(100), allowNull: true },

    tipo_mensaje: {
      type: DataTypes.STRING(255),
      allowNull: false,
      defaultValue: 'text',
    },
    rol_mensaje: { type: DataTypes.BIGINT, allowNull: false },

    celular_recibe: { type: DataTypes.STRING(250), allowNull: true },

    responsable: { type: DataTypes.STRING(100), allowNull: true },
    uid_whatsapp: { type: DataTypes.STRING(50), allowNull: true },

    id_wamid_mensaje: { type: DataTypes.STRING(250), allowNull: true },

    // ✅ NUEVOS (BD)
    external_mid: { type: DataTypes.STRING(250), allowNull: true },
    direction: { type: DataTypes.ENUM('in', 'out'), allowNull: true },
    status_unificado: {
      type: DataTypes.ENUM(
        'received',
        'queued',
        'sent',
        'delivered',
        'read',
        'failed',
        'notification',
      ),
      allowNull: true,
    },

    texto_mensaje: { type: DataTypes.TEXT('long'), allowNull: true },
    texto_corregido_mensaje: { type: DataTypes.STRING(4000), allowNull: true },
    ruta_archivo: { type: DataTypes.STRING(4000), allowNull: true },

    calificacion_mensaje: {
      type: DataTypes.TINYINT,
      allowNull: false,
      defaultValue: 0,
    },

    json_mensaje: { type: DataTypes.TEXT('long'), allowNull: true },

    // ✅ NUEVOS (BD)
    attachments_unificado: { type: DataTypes.TEXT('long'), allowNull: true },
    meta_unificado: { type: DataTypes.TEXT('long'), allowNull: true },
    delivery_watermark: { type: DataTypes.BIGINT.UNSIGNED, allowNull: true },
    read_watermark: { type: DataTypes.BIGINT.UNSIGNED, allowNull: true },
    error_code: { type: DataTypes.INTEGER, allowNull: true },
    error_subcode: { type: DataTypes.INTEGER, allowNull: true },
    error_message: { type: DataTypes.TEXT, allowNull: true },

    json_analytics_mensaje: { type: DataTypes.STRING(1000), allowNull: true },
    total_tokens_openai_mensaje: { type: DataTypes.BIGINT, allowNull: true },
    apis_mensaje_analytics: { type: DataTypes.STRING(255), allowNull: true },

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
    updated_at: { type: DataTypes.DATE, allowNull: true },
    deleted_at: { type: DataTypes.DATE, allowNull: true },

    visto: { type: DataTypes.TINYINT, allowNull: true, defaultValue: 0 },
    notificacion_estado: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
    },

    template_name: { type: DataTypes.STRING(250), allowNull: true },
    language_code: { type: DataTypes.STRING(20), allowNull: true },
  },
  {
    tableName: 'mensajes_clientes',
    timestamps: false,
    freezeTableName: true,
  },
);

module.exports = MensajesClientes;
