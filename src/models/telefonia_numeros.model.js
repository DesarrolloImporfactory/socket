const { DataTypes } = require('sequelize');
const { db } = require('../database/config');

/**
 * Estado de verificación del número de salida de cada conexión en Zadarma.
 *
 * Zadarma solo deja usar como identificador de llamada un número verificado
 * (o comprado) en la cuenta maestra, y esa verificación se hace en su web
 * (al cliente le llega un código). No hay API para listar los verificados,
 * así que lo comprobamos intentando fijarlo en una extensión: si Zadarma lo
 * rechaza, no está verificado. Aquí queda el resultado para mostrarlo en la
 * pantalla sin volver a preguntar en cada carga. Tabla creada por db.sync.
 */
const TelefoniaNumeros = db.define(
  'telefonia_numeros',
  {
    id_configuracion: { type: DataTypes.INTEGER, allowNull: false, primaryKey: true },
    numero: { type: DataTypes.STRING(30), allowNull: false },
    verificado: { type: DataTypes.TINYINT, allowNull: false, defaultValue: 0 },
    detalle: { type: DataTypes.STRING(200), allowNull: true },
    comprobado_at: { type: DataTypes.DATE, allowNull: true },
  },
  { tableName: 'telefonia_numeros', timestamps: false, freezeTableName: true },
);

module.exports = TelefoniaNumeros;
