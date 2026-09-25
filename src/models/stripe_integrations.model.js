const { DataTypes } = require('sequelize');
const { db } = require('../database/config');

/**
 * Llave de Stripe propia de cada cuenta (id_configuracion), para crear
 * enlaces de pago desde el chat. Cifrada con utils/cryptoToken igual que los
 * tokens de Dropi y Aliclik. DDL: stripe_pagos_migration.sql.
 */
const StripeIntegrations = db.define(
  'stripe_integrations',
  {
    id: {
      type: DataTypes.BIGINT.UNSIGNED,
      allowNull: false,
      autoIncrement: true,
      primaryKey: true,
    },
    id_configuracion: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    nombre: { type: DataTypes.STRING(150), allowNull: false },
    secret_key_enc: { type: DataTypes.TEXT, allowNull: false },
    key_last4: { type: DataTypes.STRING(4), allowNull: true },
    // Se deduce del prefijo de la llave (sk_test_ / rk_test_ → test).
    modo: {
      type: DataTypes.ENUM('live', 'test'),
      allowNull: false,
      defaultValue: 'live',
    },
    moneda_default: {
      type: DataTypes.STRING(3),
      allowNull: false,
      defaultValue: 'usd',
    },
    account_id: { type: DataTypes.STRING(64), allowNull: true },
    account_nombre: { type: DataTypes.STRING(150), allowNull: true },
    is_active: { type: DataTypes.TINYINT, allowNull: false, defaultValue: 1 },
    deleted_at: { type: DataTypes.DATE, allowNull: true, defaultValue: null },
  },
  {
    tableName: 'stripe_integrations',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
    freezeTableName: true,
    indexes: [
      {
        name: 'uq_stripe_integrations',
        unique: true,
        fields: ['id_configuracion', 'deleted_at'],
      },
      { name: 'idx_stripe_integrations_config', fields: ['id_configuracion'] },
    ],
  },
);

module.exports = StripeIntegrations;
