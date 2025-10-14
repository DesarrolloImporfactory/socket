const { DataTypes } = require('sequelize');
const { db_2 } = require('../database/config');

const UsuarioPlataforma = db_2.define(
  'usuario_plataforma',
  {
    id: {
      type: DataTypes.BIGINT.UNSIGNED,
      allowNull: false,
      autoIncrement: true,
      primaryKey: true,
    },
    id_usuario: {
      type: DataTypes.BIGINT.UNSIGNED,
      allowNull: true,
      references: {
        model: 'users',
        key: 'id_users',
      },
      onUpdate: 'CASCADE',
      onDelete: 'CASCADE',
    },
    id_plataforma: {
      type: DataTypes.BIGINT.UNSIGNED,
      allowNull: true,
      references: {
        model: 'plataformas',
        key: 'id_plataforma',
      },
      onUpdate: 'CASCADE',
      onDelete: 'CASCADE',
    },
  },
  {
    tableName: 'usuario_plataforma',
    timestamps: false,
    freezeTableName: true,
  }
);

module.exports = UsuarioPlataforma;
