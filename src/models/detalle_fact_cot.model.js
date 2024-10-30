const { DataTypes } = require('sequelize');
const { db } = require('../database/config');

const DetalleFactCot = db.define(
  'detalle_fact_cot',
  {
    id_detalle: {
      type: DataTypes.INTEGER,
      allowNull: false,
      autoIncrement: true,
      primaryKey: true,
    },
    id_factura: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    numero_factura: {
      type: DataTypes.STRING(25),
      allowNull: false,
    },
    id_producto: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    sku: {
      type: DataTypes.STRING(100),
      allowNull: false,
    },
    id_plataforma: {
      type: DataTypes.BIGINT.UNSIGNED,
      allowNull: false,
    },
    cantidad: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    desc_venta: {
      type: DataTypes.INTEGER,
      defaultValue: 0,
    },
    precio_venta: {
      type: DataTypes.DOUBLE,
      allowNull: false,
    },
    id_inventario: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    descripcion: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    combo: {
      type: DataTypes.INTEGER,
      defaultValue: 0,
      allowNull: false,
    },
    id_combo: {
      type: DataTypes.INTEGER,
      defaultValue: 0,
      allowNull: false,
    },
  },
  {
    sequelize: db,
    tableName: 'detalle_fact_cot',
    timestamps: false,
  }
);

module.exports = DetalleFactCot;
