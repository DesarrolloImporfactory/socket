const { DataTypes } = require('sequelize');
const { db } = require('../database/config');

const DropiDailyMetrics = db.define(
  'dropi_daily_metrics',
  {
    id: {
      type: DataTypes.INTEGER,
      autoIncrement: true,
      primaryKey: true,
    },
    id_configuracion: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
    },
    id_usuario: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
    },
    fecha: {
      type: DataTypes.DATEONLY,
      allowNull: false,
    },
    gasto_diario: {
      type: DataTypes.DECIMAL(10, 2),
      defaultValue: 0,
    },
    num_mensajes: {
      type: DataTypes.INTEGER,
      defaultValue: 0,
    },
    gastos_adicionales: {
      type: DataTypes.DECIMAL(10, 2),
      defaultValue: 0,
    },
  },
  {
    tableName: 'dropi_daily_metrics',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
  },
);

module.exports = DropiDailyMetrics;
