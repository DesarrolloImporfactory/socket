const { DataTypes } = require('sequelize');
const { db_2 } = require('../../database/config');
const CotizadorproCodigoProveedores = db_2.define(
  'cotizadorpro_codigo_proveedores',
  {
    id_codigo: {
      type: DataTypes.BIGINT.UNSIGNED,
      primaryKey: true,
      autoIncrement: true,
    },
    id_cotizacion: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    codigo: { type: DataTypes.STRING(11), allowNull: false },
    fecha_creacion: {
      type: DataTypes.TIMESTAMP,
      allowNull: false,
      defaultValue: db_2.literal('CURRENT_TIMESTAMP'),
    },
  },
  {
    tableName: 'cotizadorpro_codigo_proveedores',
    timestamps: false,
    freezeTableName: true,
  }
);

module.exports = CotizadorproCodigoProveedores;