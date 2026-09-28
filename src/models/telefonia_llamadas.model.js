const { DataTypes } = require('sequelize');
const { db } = require('../database/config');

/**
 * Llamadas telefónicas (red celular/fija) hechas por Zadarma, pagadas con
 * saldo. Distintas de llamadas_whatsapp: aquí el cliente no necesita datos.
 *
 * Una fila por llamada. Se crea al pedirle a Zadarma el "callback" (primero
 * suena la extensión del asesor en el widget, luego marca al cliente) y se
 * completa con los webhooks NOTIFY_OUT_START / NOTIFY_OUT_END / NOTIFY_RECORD
 * (services/zadarma.service.js). Tabla creada por db.sync.
 */
const TelefoniaLlamadas = db.define(
  'telefonia_llamadas',
  {
    id: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false, autoIncrement: true, primaryKey: true },
    id_configuracion: { type: DataTypes.INTEGER, allowNull: false },
    id_cliente_chat_center: { type: DataTypes.INTEGER, allowNull: true },
    id_sub_usuario: { type: DataTypes.INTEGER, allowNull: false },
    /** Extensión de la central (100, 101…) que usó el asesor. */
    extension: { type: DataTypes.STRING(20), allowNull: false },
    telefono_cliente: { type: DataTypes.STRING(30), allowNull: false },
    /** Número que vio el cliente en pantalla (CallerID verificado). */
    caller_id: { type: DataTypes.STRING(30), allowNull: true },
    /** Id de Zadarma; llega en los webhooks. */
    pbx_call_id: { type: DataTypes.STRING(120), allowNull: true },
    /** pedida → ringing → answered | no_answer | busy | failed | cancel */
    estado: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'pedida' },
    disposition: { type: DataTypes.STRING(40), allowNull: true },
    inicio_at: { type: DataTypes.DATE, allowNull: false },
    fin_at: { type: DataTypes.DATE, allowNull: true },
    /** Segundos conversados (los que cobra Zadarma y los que descontamos). */
    duracion_seg: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
    /** Centavos descontados del saldo de la conexión. */
    costo_centavos: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
    grabada: { type: DataTypes.TINYINT, allowNull: false, defaultValue: 0 },
    call_id_with_rec: { type: DataTypes.STRING(160), allowNull: true },
    /** Enlace a la grabación (vigencia larga pedida a Zadarma). */
    grabacion_url: { type: DataTypes.STRING(600), allowNull: true },
  },
  {
    tableName: 'telefonia_llamadas',
    timestamps: false,
    freezeTableName: true,
    indexes: [
      { name: 'idx_tel_llamada_cfg_inicio', fields: ['id_configuracion', 'inicio_at'] },
      { name: 'idx_tel_llamada_pbx', fields: ['pbx_call_id'] },
      { name: 'idx_tel_llamada_cliente', fields: ['id_cliente_chat_center'] },
    ],
  },
);

module.exports = TelefoniaLlamadas;
