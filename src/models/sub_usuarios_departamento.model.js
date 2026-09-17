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
    asignacion_auto: {
      type: DataTypes.TINYINT,
      allowNull: false,
      defaultValue: 0
    },
    // Canales que recibe en este departamento: "wa,ms,ig" separados por coma.
    // Columna de sub_usuarios_departamento_canales_migration.sql; el CRUD la
    // escribe solo si existe (utils/canalesDepartamento.tieneColumnaCanales).
    canales: {
      type: DataTypes.STRING(20),
      allowNull: false,
      defaultValue: 'wa',
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
