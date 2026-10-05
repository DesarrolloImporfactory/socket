const { DataTypes } = require('sequelize');
const { db } = require('../database/config');

/**
 * Seguimiento del supervisor sobre una llamada telefónica.
 *
 * La IA marca "para revisar" las llamadas con atención baja, cliente molesto
 * o reclamo; quien supervisa la conexión deja aquí qué pasó con ella:
 *   - pendiente: la marcó a mano para revisarla (aunque la IA no la marcara).
 *   - resuelta:  ya se atendió; la nota dice la solución que se dio.
 *   - escalada:  se pasó a otra persona o área; la nota dice a quién.
 * Una fila por llamada (la última decisión). Tabla creada por db.sync.
 */
const TelefoniaRevisiones = db.define(
  'telefonia_revisiones',
  {
    id_llamada: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false, primaryKey: true },
    id_configuracion: { type: DataTypes.INTEGER, allowNull: false },
    estado: { type: DataTypes.STRING(20), allowNull: false },
    nota: { type: DataTypes.TEXT, allowNull: true },
    /** Quién dejó el seguimiento. */
    id_sub_usuario: { type: DataTypes.INTEGER, allowNull: false },
    updated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
  },
  {
    tableName: 'telefonia_revisiones',
    timestamps: false,
    freezeTableName: true,
    indexes: [{ name: 'idx_tel_rev_cfg', fields: ['id_configuracion', 'estado'] }],
  },
);

module.exports = TelefoniaRevisiones;
