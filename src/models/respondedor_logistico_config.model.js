// models/respondedor_logistico_config.model.js
// Ajustes por cuenta del respondedor logístico sin IA
// (utils/respondedorLogistico.js): el negocio puede apagarlo o fijar a mano
// el rango de días de entrega que se informa en la intención "demora".
//
// SIN fila = comportamiento por defecto: respondedor encendido y rango
// calculado automáticamente con las entregas reales (delivered_at). Así las
// cuentas existentes no cambian en nada hasta que alguien toque la pantalla.
//
// Va en tabla aparte a propósito: la BD es la misma en dev y producción, y
// `db.sync` crea tablas nuevas pero NO altera las existentes.
const { DataTypes } = require('sequelize');
const { db } = require('../database/config');

const RespondedorLogisticoConfig = db.define(
  'respondedor_logistico_config',
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
      allowNull: false,
    },
    id_configuracion: {
      type: DataTypes.BIGINT,
      allowNull: false,
      unique: true,
    },

    // Interruptor general: 0 apaga las 3 intenciones (guía, retiro, demora)
    // y las preguntas quedan para el humano, como antes de este módulo.
    activo: { type: DataTypes.TINYINT, allowNull: false, defaultValue: 1 },

    // Rango manual de días para "demora". Ambos NULL = automático (histórico
    // real). Si el negocio fija un rango, se informa tal cual — bajo su
    // responsabilidad: la pantalla le muestra el rango real como referencia.
    demora_dias_min: { type: DataTypes.INTEGER, allowNull: true },
    demora_dias_max: { type: DataTypes.INTEGER, allowNull: true },

    created_at: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: DataTypes.NOW,
    },
    updated_at: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: DataTypes.NOW,
    },
  },
  {
    tableName: 'respondedor_logistico_config',
    timestamps: false,
    indexes: [{ unique: true, fields: ['id_configuracion'] }],
  },
);

module.exports = RespondedorLogisticoConfig;
