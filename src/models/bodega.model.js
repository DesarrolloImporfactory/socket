const { DataTypes } = require('sequelize');
const { db_2 } = require('../database/config');

const Bodega = db_2.define(
  'bodega',
  {
    id: {
      type: DataTypes.BIGINT.UNSIGNED,
      allowNull: false,
      autoIncrement: true,
      primaryKey: true,
    },
    nombre: {
      type: DataTypes.STRING(100),
      allowNull: false,
    },
    responsable: {
      type: DataTypes.STRING(100),
      allowNull: false,
    },
    contacto: {
      type: DataTypes.STRING(120),
      allowNull: false,
    },
    localidad: {
      type: DataTypes.STRING(5),
      allowNull: false,
    },
    provincia: {
      type: DataTypes.STRING(10),
      allowNull: false,
    },
    direccion: {
      type: DataTypes.STRING(150),
      allowNull: false,
    },
    num_casa: {
      type: DataTypes.STRING(100),
      allowNull: false,
    },
    referencia: {
      type: DataTypes.STRING(150),
      allowNull: false,
    },
    longitud: {
      type: DataTypes.DOUBLE,
      allowNull: false,
    },
    latitud: {
      type: DataTypes.DOUBLE,
      allowNull: false,
    },
    global: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    full_filme: {
      type: DataTypes.DOUBLE,
      allowNull: false,
    },
    full_filme_adicional: {
      type: DataTypes.DOUBLE,
      allowNull: false,
    },
    id_empresa: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    id_plataforma: {
      type: DataTypes.BIGINT.UNSIGNED,
      allowNull: false,
    },
    eliminado: {
      type: DataTypes.TINYINT,
      allowNull: false,
    },
  },
  {
    sequelize: db_2,
    tableName: 'bodega',
    timestamps: false,
  }
);

module.exports = Bodega;
