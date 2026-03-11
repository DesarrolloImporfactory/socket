const { DataTypes } = require('sequelize');
const { db } = require('../database/config');

const ProductosIA = db.define(
  'productos_ia',
  {
    id: {
      type: DataTypes.BIGINT.UNSIGNED,
      primaryKey: true,
      autoIncrement: true,
    },
    id_usuario: {
      type: DataTypes.BIGINT.UNSIGNED,
      allowNull: false,
    },
    id_sub_usuario: {
      type: DataTypes.BIGINT,
      allowNull: true,
      defaultValue: null,
    },
    nombre: {
      type: DataTypes.STRING(200),
      allowNull: false,
    },
    descripcion: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    imagen_portada: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    marca: {
      type: DataTypes.STRING(150),
      allowNull: true,
    },
    moneda: {
      type: DataTypes.STRING(10),
      defaultValue: 'USD',
    },
    precio_unitario: {
      type: DataTypes.DECIMAL(12, 2),
      allowNull: true,
    },
    combos: {
      type: DataTypes.TEXT,
      allowNull: true,
      get() {
        const raw = this.getDataValue('combos');
        if (!raw) return [];
        try {
          return JSON.parse(raw);
        } catch {
          return [];
        }
      },
      set(val) {
        this.setDataValue('combos', val ? JSON.stringify(val) : null);
      },
    },
    estado: {
      type: DataTypes.ENUM('activo', 'archivado'),
      defaultValue: 'activo',
    },
    created_at: {
      type: DataTypes.DATE,
      defaultValue: DataTypes.NOW,
    },
    updated_at: {
      type: DataTypes.DATE,
      defaultValue: DataTypes.NOW,
    },
  },
  {
    tableName: 'productos_ia',
    timestamps: false,
  },
);

module.exports = ProductosIA;
