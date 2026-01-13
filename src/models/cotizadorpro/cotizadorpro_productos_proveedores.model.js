const { DataTypes } = require('sequelize');
const { db_2 } = require('../../database/config');

const CotizadorproProductosProveedores = db_2.define(
  'cotizadorpro_productos_proveedores',
  {
    id_producto_proveedor: {
      type: DataTypes.BIGINT.UNSIGNED,
      primaryKey: true,
        autoIncrement: true,
    },
    id_producto: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    id_proveedor: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
},
{
    tableName: 'cotizadorpro_productos_proveedores',    
    timestamps: false,
    freezeTableName: true,
    }
);

module.exports = CotizadorproProductosProveedores;