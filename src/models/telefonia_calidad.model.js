const { DataTypes } = require('sequelize');
const { db } = require('../database/config');

/**
 * Calidad de red de una llamada telefónica, medida en el navegador del
 * asesor (WebRTC getStats sobre la conexión del widget de Zadarma) y enviada
 * al colgar. Sirve para saber si un "se entrecorta" viene del internet del
 * asesor (pérdida de subida, jitter o latencia altos) o de la ruta del
 * proveedor (estos números sanos y aun así se oye mal).
 *
 * Referencia: pérdida < 2 % y jitter < 30 ms = buena; pérdida > 5 % o
 * jitter > 60 ms = se nota entrecortado. Tabla creada por db.sync.
 */
const TelefoniaCalidad = db.define(
  'telefonia_calidad',
  {
    id_llamada: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false, primaryKey: true },
    muestras: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
    /** % de paquetes de voz del asesor que no llegaron (lo que oye el cliente). */
    perdida_subida_pct: { type: DataTypes.DECIMAL(5, 2), allowNull: true },
    /** % de paquetes del cliente que no llegaron al asesor. */
    perdida_bajada_pct: { type: DataTypes.DECIMAL(5, 2), allowNull: true },
    jitter_ms: { type: DataTypes.DECIMAL(8, 2), allowNull: true },
    /** Ida y vuelta navegador ↔ Zadarma. */
    rtt_ms: { type: DataTypes.DECIMAL(8, 2), allowNull: true },
    updated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
  },
  { tableName: 'telefonia_calidad', timestamps: false, freezeTableName: true },
);

module.exports = TelefoniaCalidad;
