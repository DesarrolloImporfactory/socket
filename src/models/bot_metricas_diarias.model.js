const { DataTypes } = require('sequelize');
const { db } = require('../database/config');

/* Snapshot diario del rendimiento del bot por cuenta. Lo llena el cron
   botMetricasSnapshot (recalcula los últimos días en cada corrida, porque las
   órdenes Dropi y sus estados llegan con retraso) y lo lee el tablero
   superadmin de salud del bot (admin_bot_salud). Una fila = (fecha, cuenta). */
const BotMetricasDiarias = db.define(
  'bot_metricas_diarias',
  {
    id: {
      type: DataTypes.BIGINT.UNSIGNED,
      primaryKey: true,
      autoIncrement: true,
    },
    fecha: { type: DataTypes.DATEONLY, allowNull: false },
    id_configuracion: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },

    /* Embudo de conversación (mensajes_clientes del día) */
    convers_ia: { type: DataTypes.INTEGER.UNSIGNED, defaultValue: 0 }, // contactos que la IA atendió ese día
    convers_respondieron: { type: DataTypes.INTEGER.UNSIGNED, defaultValue: 0 }, // de esos, escribieron después del primer mensaje IA del día
    respuestas_ia: { type: DataTypes.INTEGER.UNSIGNED, defaultValue: 0 }, // mensajes salientes IA_%

    /* Auto-orden (dropi_auto_ordenes_log del día) */
    auto_intentos: { type: DataTypes.INTEGER.UNSIGNED, defaultValue: 0 },
    auto_creadas: { type: DataTypes.INTEGER.UNSIGNED, defaultValue: 0 },
    auto_fallidas: { type: DataTypes.INTEGER.UNSIGNED, defaultValue: 0 },

    /* Órdenes Dropi del día (dropi_orders_cache, creadas por quien sea) */
    ordenes_total: { type: DataTypes.INTEGER.UNSIGNED, defaultValue: 0 },
    /* Cierres atribuidos al bot: orden cuyo teléfono tuvo conversación IA en
       los 30 días previos a la orden (misma cuenta). */
    cierres_bot: { type: DataTypes.INTEGER.UNSIGNED, defaultValue: 0 },
    entregadas_bot: { type: DataTypes.INTEGER.UNSIGNED, defaultValue: 0 },
    canceladas_bot: { type: DataTypes.INTEGER.UNSIGNED, defaultValue: 0 },
  },
  {
    tableName: 'bot_metricas_diarias',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
    indexes: [
      { unique: true, fields: ['fecha', 'id_configuracion'] },
      { fields: ['id_configuracion'] },
    ],
  },
);

module.exports = BotMetricasDiarias;
