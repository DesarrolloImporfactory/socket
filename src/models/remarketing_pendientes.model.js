const { DataTypes } = require('sequelize');
const { db } = require('../database/config');

const RemarketingPendientes = db.define(
  'remarketing_pendientes',
  {
    id: {
      type: DataTypes.INTEGER.UNSIGNED,
      autoIncrement: true,
      primaryKey: true,
    },
    telefono: {
      type: DataTypes.STRING(20),
      allowNull: false,
    },
    id_cliente_chat_center: {
      type: DataTypes.BIGINT,
      allowNull: true,
    },
    id_configuracion: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    business_phone_id: {
      type: DataTypes.STRING(50),
      allowNull: false,
    },
    access_token: {
      type: DataTypes.TEXT,
      allowNull: false,
    },
    openai_token: {
      type: DataTypes.TEXT,
      allowNull: false,
    },
    mensaje: {
      type: DataTypes.TEXT,
      allowNull: false,
    },
    tipo_asistente: {
      type: DataTypes.STRING(50),
      allowNull: true,
      defaultValue: null,
    },
    id_thread: {
      type: DataTypes.STRING(100),
      allowNull: false,
    },
    assistant_id: {
      type: DataTypes.TEXT,
      allowNull: true, // o false si lo vuelves obligatorio
    },
    tiempo_disparo: {
      type: DataTypes.DATE,
      allowNull: false,
    },
    enviado: {
      type: DataTypes.TINYINT,
      allowNull: false,
      defaultValue: 0,
    },
    cancelado: {
      type: DataTypes.TINYINT,
      allowNull: false,
      defaultValue: 0,
    },
    creado_en: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: DataTypes.NOW,
    },
  },
  {
    tableName: 'remarketing_pendientes',
    timestamps: false,
    freezeTableName: true,
  }
);

module.exports = RemarketingPendientes;
