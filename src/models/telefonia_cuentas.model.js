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
    /** Conexión TITULAR cuyo saldo (y precio por minuto) usa esta conexión.
     *  Varias conexiones del mismo dueño (id_usuario) comparten una sola
     *  bolsa: las recargas y los consumos se asientan en la titular. NULL =
     *  saldo propio. Un solo nivel (la titular no comparte de nadie).
     *  Columna agregada a mano (telefonia_saldo_compartido_migration.sql). */
    id_configuracion_saldo: { type: DataTypes.INTEGER, allowNull: true },
    /** Saldo en centavos de dólar. */
    saldo_centavos: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    /** Fracción de centavo que sobró del último cobro (0 ≤ resto < 1). Cada
     *  llamada se cobra por su costo real, que casi nunca es un número
     *  entero de centavos; la fracción se arrastra a la siguiente para que
     *  lo cobrado nunca se aleje más de 1 centavo del costo real acumulado.
     *  Columna agregada a mano (telefonia_cobro_real_migration.sql). */
    resto_centavos: { type: DataTypes.DECIMAL(8, 6), allowNull: false, defaultValue: 0 },
    /** Precio de venta por minuto a celulares del PAÍS de la conexión, en
     *  centavos (40 = $0.40/min). Fija el margen: las llamadas a cualquier
     *  destino se cobran con ese mismo margen sobre su costo real en Zadarma. */
    tarifa_centavos_min: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 40 },
    /** Número propio del cliente verificado en Zadarma, sin "+". */
    caller_id: { type: DataTypes.STRING(30), allowNull: true },
    activo: { type: DataTypes.TINYINT, allowNull: false, defaultValue: 1 },
    updated_at: { type: DataTypes.DATE, allowNull: true },
  },
  { tableName: 'telefonia_cuentas', timestamps: false, freezeTableName: true },
);

module.exports = TelefoniaCuentas;
