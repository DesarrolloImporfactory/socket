const { DataTypes } = require('sequelize');
const { db } = require('../database/config');

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
    pais: {
      type: DataTypes.STRING(2),
      allowNull: true,
      defaultValue: "ec",
    },
    id_plataforma: {
      type: DataTypes.BIGINT,
      allowNull: true,
      unique: true,
    },
    id_usuario: {
      type: DataTypes.BIGINT,
      allowNull: true,
    },
    metodo_pago: {
      type: DataTypes.INTEGER,
      allowNull: true,
      defaultValue: 1,
    },
    suspendido: {
      type: DataTypes.TINYINT, // o DataTypes.BOOLEAN, pero TINYINT mapea 0/1
      allowNull: false,
      defaultValue: 0,
    },
    suspended_at: {
      type: DataTypes.DATE,
      allowNull: true,
      defaultValue: null,
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
      type: DataTypes.STRING(20), // En tu tabla es VARCHAR(20)
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
    webhook_url: {
      type: DataTypes.STRING(255),
      allowNull: true,
    },
    template_generar_guia: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    api_key_openai: {
      type: DataTypes.STRING(1000),
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
    tipo_configuracion: {
      type: DataTypes.ENUM('imporfactory', 'ventas'),
      allowNull: true,
      defaultValue: 'ventas',
    },
    permiso_round_robin: {
      type: DataTypes.TINYINT, // o DataTypes.BOOLEAN, pero TINYINT mapea 0/1
      allowNull: false,
      defaultValue: 0,
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
