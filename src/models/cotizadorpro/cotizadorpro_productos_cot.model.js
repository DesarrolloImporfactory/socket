const { DataTypes } = require('sequelize');
const { db_2 } = require('../../database/config');

const CotizadorproProductosCot = db_2.define(
  'cotizadorpro_productos_cot',
  {
    id_producto_cot: {
      type: DataTypes.BIGINT.UNSIGNED,
      primaryKey: true,
      autoIncrement: true,
    },
    id_producto: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    id_cotizacion: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    id_proveedor: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    cbm: { type: DataTypes.DOUBLE, allowNull: false },
    peso: { type: DataTypes.DOUBLE, allowNull: false },
    precio: { type: DataTypes.DOUBLE, allowNull: false },
    cant: { type: DataTypes.INTEGER, allowNull: false },
    flete: { type: DataTypes.DOUBLE, allowNull: false },
    gastos: { type: DataTypes.DOUBLE, allowNull: false },
    gastosAdicionales: { type: DataTypes.DOUBLE, allowNull: false },
    impuesto: { type: DataTypes.DOUBLE, allowNull: false },
    arancel: { type: DataTypes.DOUBLE, allowNull: false },
  },
  {
    tableName: 'cotizadorpro_productos_cot',
    timestamps: false,
    freezeTableName: true,
  }
);
module.exports = CotizadorproProductosCot;
