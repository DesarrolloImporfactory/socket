const { DataTypes } = require('sequelize');
const { db } = require('../database/config');

const GeneracionesAngulosIA = db.define(
  'GeneracionesAngulosIA',
  {
    id: {
      type: DataTypes.INTEGER.UNSIGNED,
      autoIncrement: true,
      primaryKey: true,
    },
    id_usuario: {
      type: DataTypes.INTEGER.UNSIGNED,
      allowNull: false,
    },
    created_at: {
      type: DataTypes.DATE,
      defaultValue: DataTypes.NOW,
    },
  },
  {
    tableName: 'generaciones_angulos_ia',
    timestamps: false,
  },
);

module.exports = GeneracionesAngulosIA;
