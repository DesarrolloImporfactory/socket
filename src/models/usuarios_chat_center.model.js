const { DataTypes } = require('sequelize');
const { db } = require('../database/config');

const Usuarios_chat_center = db.define(
  'usuarios_chat_center',
  {
    id_usuario: {
      type: DataTypes.INTEGER,
      autoIncrement: true,
      primaryKey: true,
      allowNull: true,
    },
    id_plan: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
    id_plataforma: {
      type: DataTypes.BIGINT,
      allowNull: true,
    },
    permanente: {
      type: DataTypes.TINYINT,
      allowNull: true,
      defaultValue: 0,
    },
    nombre: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    fecha_inicio: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    fecha_renovacion: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    estado: {
      type: DataTypes.STRING,
      allowNull: true,
      defaultValue: 'inactivo',
    },
    subusuarios_adicionales: {
      type: DataTypes.INTEGER,
      allowNull: true,
      defaultValue: 0,
    },
    conexiones_adicionales: {
      type: DataTypes.INTEGER,
      allowNull: true,
      defaultValue: 0,
    },
    free_trial_used: {
      type: DataTypes.TINYINT,
      allowNull: true,
      defaultValue: 0,
    },
    tour_conexiones_dismissed: {
      type: DataTypes.TINYINT,
      allowNull: false,
      defaultValue: 0,
    },
    tipo_plan: {
      type: DataTypes.ENUM('mensual', 'conversaciones'),
      allowNull: true,
      defaultValue: 'mensual',
    },
    email_propietario: {
      type: DataTypes.STRING,
      allowNull: true,
      unique: true,
    },
    id_costumer: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    cant_conversaciones_mes: {
      type: DataTypes.INTEGER,
      allowNull: true,
      defaultValue: 0,
    },
    stripe_subscription_id: {
      type: DataTypes.STRING(255),
      allowNull: true,
    },
    trial_end: {
      type: DataTypes.DATE,
      allowNull: true,
    },
  },
  {
    sequelize: db,
    tableName: 'usuarios_chat_center',
    timestamps: false,
    freezeTableName: true,
  },
);

module.exports = Usuarios_chat_center;
