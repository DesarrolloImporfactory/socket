const { DataTypes } = require('sequelize');
const { db_2 } = require('../../database/config');

const CotizadorproProductos = db_2.define(
  'cotizadorpro_productos',
  {
    id_producto: {
      type: DataTypes.BIGINT.UNSIGNED,
      primaryKey: true,
        autoIncrement: true,
    },
    nombre_producto: { type: DataTypes.STRING(250), allowNull: false },
    hd_code: { type: DataTypes.STRING(13), allowNull: false },
    imagen_path: { type: DataTypes.TEXT, allowNull: true },
},
{
    tableName: 'cotizadorpro_productos',
    timestamps: false,
    freezeTableName: true,
  }
);

module.exports = CotizadorproProductos;