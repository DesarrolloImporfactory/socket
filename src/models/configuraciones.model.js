const { DataTypes } = require('sequelize');
const { db } = require('../database/config'); // Asegúrate de importar tu configuración de base de datos

const Configuraciones = db.define(
  'configuraciones',
  {
    id: {
      type: DataTypes.BIGINT.UNSIGNED,
      allowNull: false,
      primaryKey: true,
      autoIncrement: true,
      comment: 'Clave Primaria',
    },
    id_plataforma: {
      type: DataTypes.BIGINT,
      allowNull: true,
      unique: true, // Configuración como clave única
    },
    key_imporsuit: {
      type: DataTypes.STRING(200),
      allowNull: true,
    },
    nombre_configuracion: {
      type: DataTypes.STRING(255),
      allowNull: true,
    },
    telefono: {
      type: DataTypes.BIGINT,
      allowNull: true,
    },
    id_telefono: {
      type: DataTypes.STRING(255),
      allowNull: true,
    },
    id_whatsapp: {
      type: DataTypes.STRING(255),
      allowNull: true,
    },
    token: {
      type: DataTypes.STRING(255),
      allowNull: true,
    },
    crm: {
      type: DataTypes.STRING(255),
      allowNull: true,
    },
    webhook_url: {
      type: DataTypes.STRING(255),
      allowNull: true,
    },
    server: {
      type: DataTypes.STRING(255),
      allowNull: true,
    },
    port: {
      type: DataTypes.STRING(255),
      allowNull: true,
    },
    security: {
      type: DataTypes.STRING(255),
      allowNull: true,
    },
    from_name: {
      type: DataTypes.STRING(255),
      allowNull: true,
    },
    from_email: {
      type: DataTypes.STRING(255),
      allowNull: true,
    },
    auth_required: {
      type: DataTypes.TINYINT,
      allowNull: true,
    },
    usuario: {
      type: DataTypes.STRING(255),
      allowNull: true,
    },
    contrasena: {
      type: DataTypes.STRING(255),
      allowNull: true,
    },
    created_at: {
      type: DataTypes.DATE,
      allowNull: true,
      defaultValue: null,
    },
    updated_at: {
      type: DataTypes.DATE,
      allowNull: true,
      defaultValue: null,
    },
  },
  {
    tableName: 'configuraciones',
    timestamps: false,
    comment: 'Tabla de configuraciones',
    freezeTableName: true,
  }
);

module.exports = Configuraciones;
