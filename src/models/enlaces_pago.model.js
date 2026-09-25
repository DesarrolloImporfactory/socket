const { DataTypes } = require('sequelize');
const { db } = require('../database/config');

/**
 * Una fila por factura de Stripe creada desde el chat (o por el bot). El
 * estado se sincroniza consultando la factura con la llave de la cuenta:
 * al abrir el chat del contacto y por cron cada 10 min (cron/
 * sincronizarEnlacesPago.js). DDL: stripe_pagos_migration.sql.
 */
const EnlacesPago = db.define(
  'enlaces_pago',
  {
    id: {
      type: DataTypes.BIGINT.UNSIGNED,
      allowNull: false,
      autoIncrement: true,
      primaryKey: true,
    },
    id_configuracion: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    id_cliente_chat_center: {
      type: DataTypes.BIGINT.UNSIGNED,
      allowNull: false,
    },
    id_sub_usuario: { type: DataTypes.BIGINT.UNSIGNED, allowNull: true },
    origen: {
      type: DataTypes.ENUM('asesor', 'bot', 'api'),
      allowNull: false,
      defaultValue: 'asesor',
    },
    stripe_customer_id: { type: DataTypes.STRING(64), allowNull: true },
    stripe_invoice_id: { type: DataTypes.STRING(64), allowNull: false },
    stripe_payment_intent: { type: DataTypes.STRING(64), allowNull: true },
    url_pago: { type: DataTypes.STRING(500), allowNull: false },
    url_pdf: { type: DataTypes.STRING(500), allowNull: true },
    monto: { type: DataTypes.DECIMAL(12, 2), allowNull: false },
    moneda: { type: DataTypes.STRING(3), allowNull: false, defaultValue: 'usd' },
    concepto: { type: DataTypes.STRING(255), allowNull: false },
    estado: {
      type: DataTypes.ENUM('pendiente', 'pagado', 'anulado'),
      allowNull: false,
      defaultValue: 'pendiente',
    },
    vence_at: { type: DataTypes.DATE, allowNull: true },
    pagado_at: { type: DataTypes.DATE, allowNull: true },
    anulado_at: { type: DataTypes.DATE, allowNull: true },
    id_mensaje: { type: DataTypes.BIGINT.UNSIGNED, allowNull: true },
    ultimo_check_at: { type: DataTypes.DATE, allowNull: true },
  },
  {
    tableName: 'enlaces_pago',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
    freezeTableName: true,
    indexes: [
      {
        name: 'uq_enlaces_pago_invoice',
        unique: true,
        fields: ['stripe_invoice_id'],
      },
      {
        name: 'idx_enlaces_pago_config_estado',
        fields: ['id_configuracion', 'estado', 'created_at'],
      },
      {
        name: 'idx_enlaces_pago_cliente',
        fields: ['id_cliente_chat_center', 'created_at'],
      },
    ],
  },
);

module.exports = EnlacesPago;
