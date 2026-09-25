const { DataTypes } = require('sequelize');
const { db } = require('../database/config');

/**
 * Historial de llamadas de voz por WhatsApp (Business Calling API).
 *
 * Una fila por llamada (call_id = "wacid.…" de Meta). Se crea cuando Meta
 * avisa que el cliente está llamando (webhook `calls`, evento connect) y se
 * cierra con el evento terminate, que trae estado y duración. Sirve para el
 * chat (notificación "llamada atendida / perdida") y para las métricas por
 * asesor del dashboard de atención. Tabla creada por db.sync.
 */
const LlamadasWhatsapp = db.define(
  'llamadas_whatsapp',
  {
    id: {
      type: DataTypes.BIGINT.UNSIGNED,
      allowNull: false,
      autoIncrement: true,
      primaryKey: true,
    },
    call_id: { type: DataTypes.STRING(120), allowNull: false },
    id_configuracion: { type: DataTypes.INTEGER, allowNull: false },
    id_cliente_chat_center: { type: DataTypes.INTEGER, allowNull: true },
    /** USER_INITIATED (el cliente llama) o BUSINESS_INITIATED. */
    direccion: { type: DataTypes.STRING(20), allowNull: false },
    telefono_cliente: { type: DataTypes.STRING(30), allowNull: true },
    /** ringing → accepted | rejected | missed | failed → completed */
    estado: { type: DataTypes.STRING(20), allowNull: false },
    /** Asesor que contestó (o rechazó). */
    id_sub_usuario: { type: DataTypes.INTEGER, allowNull: true },
    inicio_at: { type: DataTypes.DATE, allowNull: false },
    contestada_at: { type: DataTypes.DATE, allowNull: true },
    fin_at: { type: DataTypes.DATE, allowNull: true },
    duracion_seg: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
    /** Estado literal que manda Meta en terminate (Completed, Not Answered…). */
    estado_meta: { type: DataTypes.STRING(40), allowNull: true },
  },
  {
    tableName: 'llamadas_whatsapp',
    timestamps: false,
    freezeTableName: true,
    indexes: [
      { name: 'uq_llamada_call_id', unique: true, fields: ['call_id'] },
      { name: 'idx_llamada_cfg_inicio', fields: ['id_configuracion', 'inicio_at'] },
      { name: 'idx_llamada_cliente', fields: ['id_cliente_chat_center'] },
    ],
  },
);

module.exports = LlamadasWhatsapp;
