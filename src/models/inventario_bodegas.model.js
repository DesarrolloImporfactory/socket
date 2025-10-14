const { DataTypes } = require('sequelize');
const { db_2 } = require('../database/config');

const InventarioBodegas = db_2.define(
  'inventario_bodegas',
  {
    id_inventario: {
      type: DataTypes.BIGINT.UNSIGNED,
      allowNull: false,
      autoIncrement: true,
      primaryKey: true,
    },
    id_producto: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: {
        model: 'productos', // Nombre de la tabla de referencia
        key: 'id_producto',
      },
      onDelete: 'CASCADE',
      onUpdate: 'CASCADE',
    },
    sku: {
      type: DataTypes.STRING(20),
      allowNull: false,
    },
    id_variante: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    bodega: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    pcp: {
      type: DataTypes.DOUBLE,
      allowNull: true,
    },
    pvp: {
      type: DataTypes.DOUBLE,
      allowNull: false,
    },
    stock_inicial: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    saldo_stock: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    id_plataforma: {
      type: DataTypes.BIGINT.UNSIGNED,
      allowNull: false,
      references: {
        model: 'plataformas', // Nombre de la tabla de referencia
        key: 'id_plataforma',
      },
      onDelete: 'CASCADE',
      onUpdate: 'CASCADE',
    },
    pref: {
      type: DataTypes.DOUBLE,
      defaultValue: 0,
    },
  },
  {
    sequelize: db_2,
    tableName: 'inventario_bodegas',
    timestamps: false,
  }
);

module.exports = InventarioBodegas;
