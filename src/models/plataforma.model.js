const { DataTypes } = require('sequelize');
const { db } = require('../database/config');

const Plataforma = db.define(
  'plataformas',
  {
    id_plataforma: {
      type: DataTypes.BIGINT.UNSIGNED,
      allowNull: false,
      autoIncrement: true,
      primaryKey: true,
    },
    nombre_tienda: {
      type: DataTypes.STRING(150),
      allowNull: true,
      defaultValue: null,
    },
    contacto: {
      type: DataTypes.STRING(150),
      allowNull: true,
      defaultValue: null,
    },
    whatsapp: {
      type: DataTypes.STRING(150),
      allowNull: true,
      defaultValue: null,
    },
    fecha_ingreso: {
      type: DataTypes.DATEONLY,
      allowNull: true,
      defaultValue: null,
    },
    fecha_actualza: {
      type: DataTypes.DATEONLY,
      allowNull: true,
      defaultValue: null,
    },
    fecha_caduca: {
      type: DataTypes.DATEONLY,
      allowNull: true,
      defaultValue: null,
    },
    id_plan: {
      type: DataTypes.INTEGER,
      allowNull: true,
      defaultValue: null,
    },
    url_imporsuit: {
      type: DataTypes.STRING(150),
      allowNull: true,
      defaultValue: null,
    },
    dominio: {
      type: DataTypes.STRING(150),
      allowNull: true,
      defaultValue: null,
    },
    carpeta_servidor: {
      type: DataTypes.STRING(150),
      allowNull: true,
      defaultValue: null,
    },
    email: {
      type: DataTypes.STRING(200),
      allowNull: true,
      defaultValue: null,
      validate: {
        isEmail: true,
      },
    },
    referido: {
      type: DataTypes.TINYINT,
      allowNull: false,
      defaultValue: 0,
    },
    token_referido: {
      type: DataTypes.STRING(250),
      allowNull: true,
      defaultValue: null,
    },
    refiere: {
      type: DataTypes.STRING(250),
      allowNull: true,
      defaultValue: null,
    },
    estado: {
      type: DataTypes.INTEGER,
      allowNull: true,
      defaultValue: 1,
    },
    full_f: {
      type: DataTypes.INTEGER,
      allowNull: true,
      defaultValue: 0,
    },
    token_pagina: {
      type: DataTypes.TEXT,
      allowNull: true,
      defaultValue: null,
    },
    tieneDrag: {
      type: DataTypes.TINYINT,
      allowNull: true,
      defaultValue: 0,
    },
    cedula_facturacion: {
      type: DataTypes.STRING(13),
      allowNull: true,
      defaultValue: null,
    },
    correo_facturacion: {
      type: DataTypes.STRING(150),
      allowNull: true,
      defaultValue: null,
      validate: {
        isEmail: true,
      },
    },
    direccion_facturacion: {
      type: DataTypes.STRING(200),
      allowNull: true,
      defaultValue: null,
    },
    pais: {
      type: DataTypes.STRING(4),
      allowNull: false,
    },
    id_matriz: {
      type: DataTypes.INTEGER,
      allowNull: true,
      defaultValue: null,
    },
    proveedor: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
    },
    servicio_adicional: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
    },
    descripcion_tienda: {
      type: DataTypes.STRING(1500),
      allowNull: true,
      defaultValue: null,
    },
    ganacia_referido: {
      type: DataTypes.DOUBLE,
      allowNull: false,
      defaultValue: 0,
    },
    tienda_creada: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
    },
    fecha_tienda: {
      type: DataTypes.DATE,
      allowNull: true,
      defaultValue: null,
    },
  },
  {
    tableName: 'plataformas',
    timestamps: false,
    freezeTableName: true,
  }
);

module.exports = Plataforma;
