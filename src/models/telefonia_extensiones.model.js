const { DataTypes } = require('sequelize');
const { db } = require('../database/config');

/**
 * Extensión de la central de Zadarma asignada a cada asesor.
 *
 * Hay una sola cuenta de Zadarma (la maestra de Imporfactory) y en su central
 * viven las extensiones (100, 101, …). Cada asesor que llama por teléfono
 * necesita una: es la que registra el widget WebRTC en su navegador y la que
 * suena primero cuando pide una llamada. Se asigna la primera libre de la
 * central al primer uso (services/zadarma.service.js → asegurarExtension).
 * Tabla creada por db.sync.
 */
const TelefoniaExtensiones = db.define(
  'telefonia_extensiones',
  {
    id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, autoIncrement: true, primaryKey: true },
    id_sub_usuario: { type: DataTypes.INTEGER, allowNull: false },
    /** Número corto de la extensión en la central (p. ej. "100"). */
    extension: { type: DataTypes.STRING(20), allowNull: false },
    /** Login SIP completo (p. ej. "123456-100"): lo pide el widget. */
    sip_login: { type: DataTypes.STRING(60), allowNull: false },
    /** Llave temporal del widget (dura 72 h) y cuándo vence. */
    widget_key: { type: DataTypes.STRING(200), allowNull: true },
    widget_key_vence_at: { type: DataTypes.DATE, allowNull: true },
    created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
  },
  {
    tableName: 'telefonia_extensiones',
    timestamps: false,
    freezeTableName: true,
    indexes: [
      { name: 'uq_tel_ext_sub', unique: true, fields: ['id_sub_usuario'] },
      { name: 'uq_tel_ext_num', unique: true, fields: ['extension'] },
    ],
  },
);

module.exports = TelefoniaExtensiones;
