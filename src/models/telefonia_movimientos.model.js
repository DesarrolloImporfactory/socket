const { DataTypes } = require('sequelize');
const { db } = require('../database/config');

/**
 * Movimientos del saldo telefónico por conexión: recargas (+) y consumos (−).
 * El consumo lo escribe el webhook NOTIFY_OUT_END de Zadarma con los
 * segundos reales de la llamada. Tabla creada por db.sync.
 */
const TelefoniaMovimientos = db.define(
  'telefonia_movimientos',
  {
    id: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false, autoIncrement: true, primaryKey: true },
    id_configuracion: { type: DataTypes.INTEGER, allowNull: false },
    /** recarga | consumo | ajuste */
    tipo: { type: DataTypes.STRING(20), allowNull: false },
    /** Positivo suma, negativo resta (centavos). */
    centavos: { type: DataTypes.INTEGER, allowNull: false },
    saldo_despues_centavos: { type: DataTypes.INTEGER, allowNull: false },
    id_llamada: { type: DataTypes.BIGINT.UNSIGNED, allowNull: true },
    /** Quién hizo la recarga/ajuste (subusuario) o null si fue el sistema. */
    id_sub_usuario: { type: DataTypes.INTEGER, allowNull: true },
    detalle: { type: DataTypes.STRING(200), allowNull: true },
    created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
  },
  {
    tableName: 'telefonia_movimientos',
    timestamps: false,
    freezeTableName: true,
    indexes: [{ name: 'idx_tel_mov_cfg', fields: ['id_configuracion', 'created_at'] }],
  },
);

module.exports = TelefoniaMovimientos;
