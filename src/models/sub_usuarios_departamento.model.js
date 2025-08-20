const { DataTypes } = require('sequelize');
const { db } = require('../database/config');

const Sub_usuarios_departamento = db.define(
  'sub_usuarios_departamento',
  {
    id: {
      type: DataTypes.BIGINT,
      autoIncrement: true,
      primaryKey: true,
      allowNull: false,
    },
    id_departamento: {
      type: DataTypes.BIGINT,
      allowNull: false,
    },
    id_sub_usuario: {
      type: DataTypes.BIGINT,
      allowNull: false,
    },
  },
  {
    sequelize: db,
    tableName: 'sub_usuarios_departamento',
    timestamps: false,
    freezeTableName: true,
  }
);

module.exports = Sub_usuarios_departamento;
