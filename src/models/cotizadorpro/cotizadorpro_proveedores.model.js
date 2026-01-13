const { DataTypes } = require('sequelize');
const { db_2 } = require('../../database/config');

const CotizadorproProveedores = db_2.define(
  'cotizadorpro_proveedores',
  {
    id_proveedor: {
      type: DataTypes.BIGINT.UNSIGNED,
      primaryKey: true,
    },
    nombre_proveedor: { type: DataTypes.STRING(100), allowNull: false },
    telefono_proveedor: { type: DataTypes.STRING(20), allowNull: true },
    wechat: { type: DataTypes.STRING(200), allowNull: true },
    imagen_path: { type: DataTypes.TEXT, allowNull: true },
},
{
    tableName: 'cotizadorpro_proveedores',
    timestamps: false,
    freezeTableName: true,
  }
);

module.exports = CotizadorproProveedores;