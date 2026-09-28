const { DataTypes } = require('sequelize');
const { db } = require('../database/config');

/**
 * Saldo telefónico de cada conexión (libro propio, Zadarma no lo conoce).
 *
 * Compramos minutos a Zadarma desde la cuenta maestra y se los vendemos a
 * cada cliente como saldo. Aquí vive cuánto tiene cada conexión, a qué tarifa
 * se le descuenta y con qué número sale (CallerID verificado en Zadarma).
 * Los movimientos (recargas y consumos) van en telefonia_movimientos.
 * Tabla creada por db.sync.
 */
const TelefoniaCuentas = db.define(
  'telefonia_cuentas',
  {
    id_configuracion: { type: DataTypes.INTEGER, allowNull: false, primaryKey: true },
    /** Saldo en centavos de dólar. */
    saldo_centavos: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    /** Precio de venta por minuto, en centavos (40 = $0.40/min). */
    tarifa_centavos_min: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 40 },
    /** Número propio del cliente verificado en Zadarma, sin "+". */
    caller_id: { type: DataTypes.STRING(30), allowNull: true },
    activo: { type: DataTypes.TINYINT, allowNull: false, defaultValue: 1 },
    updated_at: { type: DataTypes.DATE, allowNull: true },
  },
  { tableName: 'telefonia_cuentas', timestamps: false, freezeTableName: true },
);

module.exports = TelefoniaCuentas;
