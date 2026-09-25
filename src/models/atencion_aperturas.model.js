const { DataTypes } = require('sequelize');
const { db } = require('../database/config');

/**
 * Cuándo abrió el asesor un chat que tenía al cliente esperando.
 *
 * El sidebar ya dice cuánto lleva esperando el cliente (desde su mensaje).
 * Esto mide lo otro: desde que el asesor ABRE el chat hasta que contesta. El
 * cronómetro de la cabecera arranca en 0:00 la primera vez que alguien abre
 * el chat con ese mensaje pendiente y, como la hora queda acá, sigue
 * corriendo igual si recarga la página o cambia de chat.
 *
 * Una fila = (chat, mensaje del cliente que estaba pendiente, quién lo
 * abrió). No se marca "respondido" aquí: el dashboard de atención cruza la
 * fila con la primera respuesta humana posterior en mensajes_clientes, así
 * ningún camino de envío (WhatsApp, Messenger, Instagram, plantillas) tiene
 * que tocar esta tabla.
 *
 * Tabla creada por db.sync (misma base para dev y prod).
 */
const AtencionAperturas = db.define(
  'atencion_aperturas',
  {
    id: {
      type: DataTypes.BIGINT.UNSIGNED,
      allowNull: false,
      autoIncrement: true,
      primaryKey: true,
    },
    id_configuracion: { type: DataTypes.INTEGER, allowNull: false },
    id_cliente_chat_center: { type: DataTypes.INTEGER, allowNull: false },
    id_sub_usuario: { type: DataTypes.INTEGER, allowNull: false },
    /** created_at del primer mensaje del cliente sin respuesta humana. */
    mensaje_cliente_at: { type: DataTypes.DATE, allowNull: false },
    abierto_at: { type: DataTypes.DATE, allowNull: false },
  },
  {
    tableName: 'atencion_aperturas',
    timestamps: false,
    freezeTableName: true,
    // Con nombre explícito: el que arma Sequelize (tabla + columnas) pasa
    // de los 64 caracteres que admite MySQL y tumba el sync.
    indexes: [
      {
        name: 'uq_apertura_chat_msg_sub',
        unique: true,
        fields: ['id_cliente_chat_center', 'mensaje_cliente_at', 'id_sub_usuario'],
      },
      {
        name: 'idx_apertura_cfg_abierto',
        fields: ['id_configuracion', 'abierto_at'],
      },
    ],
  },
);

module.exports = AtencionAperturas;
