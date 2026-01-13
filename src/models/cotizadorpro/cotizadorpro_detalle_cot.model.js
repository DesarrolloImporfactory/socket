const { DataTypes } = require('sequelize');
const { db_2 } = require('../../database/config');

const CotizadorproDetalleCot = db_2.define(
  'cotizadorpro_detalle_cot',
  {
    id_detalle: {
      type: DataTypes.BIGINT.UNSIGNED,
      primaryKey: true,
        autoIncrement: true,
    },
    id_cotizacion: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    pais_origen : { type: DataTypes.STRING(40), allowNull: false },
    id_users: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    telefono: { type: DataTypes.STRING(20), allowNull: false },
    tipo_transporte: { type: DataTypes.STRING(20), allowNull: false },
    tipo_envio: { type: DataTypes.STRING(20), allowNull: false },
    pais_destino: { type: DataTypes.STRING(4), allowNull: false },
    iva: { type: DataTypes.DOUBLE, allowNull: false },
},
{
    tableName: 'cotizadorpro_detalle_cot',
    timestamps: false,
    freezeTableName: true,
  }
);  

module.exports = CotizadorproDetalleCot;
