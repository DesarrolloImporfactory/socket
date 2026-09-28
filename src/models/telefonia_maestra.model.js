const { DataTypes } = require('sequelize');
const { db } = require('../database/config');

/**
 * Credenciales de la cuenta maestra de Zadarma (una sola fila, id = 1).
 *
 * Se guardan desde la pantalla /telefonia (super administrador) para no
 * depender del .env del servidor. La llave secreta va cifrada con
 * utils/cryptoToken (misma llave que los tokens de Dropi). Si no hay fila,
 * el servicio cae a ZADARMA_USER_KEY / ZADARMA_SECRET_KEY del .env.
 * Tabla creada por db.sync.
 */
const TelefoniaMaestra = db.define(
  'telefonia_maestra',
  {
    id: { type: DataTypes.TINYINT, allowNull: false, primaryKey: true, defaultValue: 1 },
    user_key: { type: DataTypes.STRING(64), allowNull: false },
    secret_enc: { type: DataTypes.TEXT, allowNull: false },
    secret_last4: { type: DataTypes.STRING(4), allowNull: true },
    /** Prefijo SIP de las extensiones (se lee de /v1/sip/ si va vacío). */
    sip_principal: { type: DataTypes.STRING(30), allowNull: true },
    webhook_url: { type: DataTypes.STRING(300), allowNull: true },
    webhook_instalado_at: { type: DataTypes.DATE, allowNull: true },
    actualizado_por: { type: DataTypes.INTEGER, allowNull: true },
    updated_at: { type: DataTypes.DATE, allowNull: true },
  },
  { tableName: 'telefonia_maestra', timestamps: false, freezeTableName: true },
);

module.exports = TelefoniaMaestra;
