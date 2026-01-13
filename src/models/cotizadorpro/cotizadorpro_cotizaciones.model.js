const { DataTypes } = require('sequelize');
const { db_2 } = require('../../database/config');

const CotizadorproCotizaciones = db_2.define(
  'cotizadorpro_cotizaciones',
  {
    id_cotizacion: {
      type: DataTypes.BIGINT.UNSIGNED,
      primaryKey: true,
      autoIncrement: true,
    },
    id_asesor: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    estado: {
      type: DataTypes.ENUM(
        'borrador',
        'generado',
        'aprobado',
        'contactado',
        'bodega',
        'transito',
        'proximo',
        'entregado',
        'rechazado',
        'anulado'
      ),
      allowNull: false,
      defaultValue: 'borrador',
    },
    fecha_creacion: {
      type: DataTypes.TIMESTAMP,
      allowNull: false,
      defaultValue: db_2.literal('CURRENT_TIMESTAMP'),
    },
    fecha_modificacion: {
      type: DataTypes.TIMESTAMP,
      allowNull: true,
      defaultValue: null,
    },
    fecha_anulacion: {
      type: DataTypes.TIMESTAMP,
      allowNull: true,
      defaultValue: null,
    },
    fecha_aprobacion: {
      type: DataTypes.TIMESTAMP,
      allowNull: true,
      defaultValue: null,
    },
  },
  {
    tableName: 'cotizadorpro_cotizaciones',
    timestamps: false,
    freezeTableName: true,
  }
);
module.exports = CotizadorproCotizaciones;
