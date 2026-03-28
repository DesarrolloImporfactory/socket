const { DataTypes } = require('sequelize');
const { db } = require('../database/config');

const Password_reset_codes = db.define(
  'password_reset_codes',
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    id_sub_usuario: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    email: {
      type: DataTypes.STRING(255),
      allowNull: false,
    },
    codigo: {
      type: DataTypes.STRING(64),
      allowNull: false,
    },
    tipo: {
      // 'codigo' = código de 6 dígitos, 'token' = token para cambiar pwd
      type: DataTypes.STRING(10),
      allowNull: false,
      defaultValue: 'codigo',
    },
    usado: {
      type: DataTypes.TINYINT,
      allowNull: false,
      defaultValue: 0,
    },
    expira_en: {
      type: DataTypes.DATE,
      allowNull: false,
    },
  },
  {
    tableName: 'password_reset_codes',
    timestamps: true, // createdAt, updatedAt
    createdAt: 'created_at',
    updatedAt: 'updated_at',
  },
);

module.exports = Password_reset_codes;
