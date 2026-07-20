const { DataTypes } = require('sequelize');
const { db } = require('../database/config');

/* Llaves de la API pública: un tercero consume las métricas de UNA
   configuración. Se guarda solo el hash (sha256) — la key en claro se
   muestra una sola vez, al crearla. */
const ApiKeys = db.define(
  'api_keys',
  {
    id: {
      type: DataTypes.BIGINT.UNSIGNED,
      allowNull: false,
      autoIncrement: true,
      primaryKey: true,
    },

    id_configuracion: {
      type: DataTypes.BIGINT.UNSIGNED,
      allowNull: false,
    },

    id_usuario: {
      type: DataTypes.BIGINT.UNSIGNED,
      allowNull: true,
    },

    // Para que el dueño identifique la llave ("ERP de Ecuamarket")
    nombre: {
      type: DataTypes.STRING(120),
      allowNull: false,
    },

    // Primeros caracteres visibles (ick_live_ab12…), solo para mostrar
    key_prefix: {
      type: DataTypes.STRING(20),
      allowNull: false,
    },

    key_hash: {
      type: DataTypes.STRING(64),
      allowNull: false,
    },

    activo: {
      type: DataTypes.TINYINT,
      allowNull: false,
      defaultValue: 1,
    },

    last_used_at: {
      type: DataTypes.DATE,
      allowNull: true,
      defaultValue: null,
    },

    usos: {
      type: DataTypes.INTEGER.UNSIGNED,
      allowNull: false,
      defaultValue: 0,
    },

    revoked_at: {
      type: DataTypes.DATE,
      allowNull: true,
      defaultValue: null,
    },
  },
  {
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
    tableName: 'api_keys',
  },
);

module.exports = ApiKeys;
