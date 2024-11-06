const { DataTypes } = require('sequelize');
const { db } = require('../database/config');

const Productos = db.define(
  'productos',
  {
    id_producto: {
      type: DataTypes.INTEGER,
      allowNull: false,
      autoIncrement: true,
      primaryKey: true,
    },
    codigo_producto: {
      type: DataTypes.STRING(255),
      allowNull: false,
    },
    nombre_producto: {
      type: DataTypes.STRING(255),
      allowNull: false,
    },
    descripcion_producto: {
      type: DataTypes.TEXT('long'),
      allowNull: true,
    },
    id_linea_producto: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    inv_producto: {
      type: DataTypes.TINYINT,
      allowNull: false,
    },
    producto_variable: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    costo_producto: {
      type: DataTypes.DOUBLE,
      allowNull: true,
    },
    aplica_iva: {
      type: DataTypes.INTEGER,
      defaultValue: 0,
    },
    estado_producto: {
      type: DataTypes.TINYINT,
      allowNull: false,
    },
    date_added: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: DataTypes.NOW,
    },
    image_path: {
      type: DataTypes.STRING(300),
      allowNull: true,
    },
    id_imp_producto: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    pagina_web: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
    formato: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
    drogshipin: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
    },
    producto_privado: {
      type: DataTypes.INTEGER,
      defaultValue: 0,
    },
    destacado: {
      type: DataTypes.INTEGER,
      defaultValue: 0,
    },
    id_plataforma: {
      type: DataTypes.BIGINT.UNSIGNED,
      allowNull: true,
      references: {
        model: 'plataformas', // Nombre de la tabla de referencia
        key: 'id_plataforma',
      },
      onDelete: 'RESTRICT',
      onUpdate: 'RESTRICT',
    },
    landing: {
      type: DataTypes.STRING(1500),
      allowNull: true,
    },
  },
  {
    sequelize: db,
    tableName: 'productos',
    timestamps: false,
  }
);

module.exports = Productos;
