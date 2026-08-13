const { DataTypes } = require('sequelize');
const { db } = require('../database/config');

/**
 * Bitácora cruda de los eventos del webhook de Aliclik + idempotencia.
 *
 * La doc de Aliclik advierte que los estados pueden llegar en desorden y
 * repetidos, y pide implementar idempotencia. El UNIQUE sobre event_hash la
 * resuelve: el mismo evento reenviado choca y no se reprocesa.
 *
 * El hash incluye el id_configuracion además del payload, porque el payload
 * (4 campos) es tan chico que dos cuentas distintas podrían generar eventos
 * idénticos y una le robaría el evento a la otra.
 */
const AliclikWebhookEvents = db.define(
  'aliclik_webhook_events',
  {
    id: {
      type: DataTypes.BIGINT.UNSIGNED,
      primaryKey: true,
      autoIncrement: true,
    },

    order_number: { type: DataTypes.STRING(60), allowNull: true },
    id_configuracion: { type: DataTypes.BIGINT.UNSIGNED, allowNull: true },

    call_status: { type: DataTypes.STRING(40), allowNull: true },
    status: { type: DataTypes.STRING(40), allowNull: true },
    dispatch_status: { type: DataTypes.STRING(40), allowNull: true },

    event_hash: { type: DataTypes.CHAR(64), allowNull: false, unique: true },

    payload: { type: DataTypes.JSON, allowNull: false },

    created_at: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: DataTypes.NOW,
    },
  },
  {
    tableName: 'aliclik_webhook_events',
    timestamps: false,
    freezeTableName: true,
  },
);

module.exports = AliclikWebhookEvents;
