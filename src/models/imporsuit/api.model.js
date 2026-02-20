const { DataTypes } = require('sequelize');
const { db_2 } = require('../../database/config');

const ImporsuitApi = db_2.define(
  'api',
  {
    id_api: {
      type: DataTypes.BIGINT.UNSIGNED,
      primaryKey: true,
      autoIncrement: true,
    },
    identificador: { type: DataTypes.STRING(100), allowNull: false },
    descripcion: { type: DataTypes.STRING(255), allowNull: true },
    id_users: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    fecha_creacion: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: db_2.literal('CURRENT_TIMESTAMP'),
    },
    fecha_modificacion: {
      type: DataTypes.DATE,
      allowNull: true,
      defaultValue: null,
    },
    fecha_eliminacion: {
      type: DataTypes.DATE,
      allowNull: true,
      defaultValue: null,
    },
  },
  {
    tableName: 'api',
    timestamps: false,
    freezeTableName: true,
  },
);

module.exports = ImporsuitApi;