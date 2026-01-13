const { DataTypes } = require('sequelize');
const { db_2 } = require('../../database/config');

const CotizadorproImagenesCot = db_2.define(
  'cotizadorpro_imagenes_cot',
  {
    id_imagen: {
      type: DataTypes.BIGINT.UNSIGNED,
      primaryKey: true,
      autoIncrement: true,
    },
    id_producto: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    url: { type: DataTypes.STRING(255), allowNull: false },
    fecha_creacion: {
      type: DataTypes.TIMESTAMP,
      allowNull: false,
      defaultValue: db_2.literal('CURRENT_TIMESTAMP'),
    }
  },
  {
    tableName: 'cotizadorpro_imagenes_cot',
    timestamps: false,
    freezeTableName: true,
  }
);

module.exports = CotizadorproImagenesCot;