const { DataTypes } = require('sequelize');
const { db } = require('../database/config');

const InstagramMessage = db.define(
  'instagram_messages',
  {
    id: {
      type: DataTypes.BIGINT.UNSIGNED,
      allowNull: false,
      autoIncrement: true,
      primaryKey: true,
    },

    conversation_id: {
      type: DataTypes.BIGINT.UNSIGNED,
      allowNull: false,
    },

    id_configuracion: {
      type: DataTypes.BIGINT.UNSIGNED,
      allowNull: false,
    },

    page_id: {
      type: DataTypes.STRING(32),
      allowNull: false,
    },

    igsid: {
      type: DataTypes.STRING(32),
      allowNull: false,
    },

    direction: {
      type: DataTypes.ENUM('in', 'out'),
      allowNull: false,
    },

    mid: {
      type: DataTypes.STRING(250),
      allowNull: true,
      defaultValue: null,
    },

    text: {
      type: DataTypes.TEXT,
      allowNull: true,
      defaultValue: null,
    },

    // En BD: longtext con collation utf8mb4_bin (normalmente es JSON/string)
    attachments: {
      type: DataTypes.TEXT('long'),
      allowNull: true,
      defaultValue: null,
    },

    status: {
      // Ajusta EXACTO a tu enum en MySQL si difiere
      type: DataTypes.ENUM(
        'received',
        'queued',
        'sent',
        'delivered',
        'read',
        'failed',
        'notification',
      ),
      allowNull: false,
    },

    delivery_watermark: {
      type: DataTypes.BIGINT.UNSIGNED,
      allowNull: true,
      defaultValue: null,
    },

    read_watermark: {
      type: DataTypes.BIGINT.UNSIGNED,
      allowNull: true,
      defaultValue: null,
    },

    error_code: {
      type: DataTypes.INTEGER,
      allowNull: true,
      defaultValue: null,
    },

    error_subcode: {
      type: DataTypes.INTEGER,
      allowNull: true,
      defaultValue: null,
    },

    error_message: {
      type: DataTypes.TEXT,
      allowNull: true,
      defaultValue: null,
    },

    // En BD: longtext utf8mb4_bin (suele ser JSON/string con metadata)
    meta: {
      type: DataTypes.TEXT('long'),
      allowNull: true,
      defaultValue: null,
    },

    created_at: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: db.literal('CURRENT_TIMESTAMP'),
    },

    updated_at: {
      type: DataTypes.DATE,
      allowNull: false,
      // En BD: current_timestamp() + ON UPDATE CURRENT_TIMESTAMP()
      defaultValue: db.literal('CURRENT_TIMESTAMP'),
    },

    id_encargado: {
      type: DataTypes.BIGINT,
      allowNull: true,
      defaultValue: null,
    },

    is_unsupported: {
      type: DataTypes.TINYINT,
      allowNull: false,
      defaultValue: 0,
    },
  },
  {
    tableName: 'instagram_messages',
    timestamps: false,
    freezeTableName: true,

    // Si luego me pasas los índices reales (SHOW INDEX), los dejo idénticos a tu BD.
    // indexes: [
    //   { name: 'ix_conv', fields: ['conversation_id'] },
    //   { name: 'ix_cfg_page_igsid', fields: ['id_configuracion', 'page_id', 'igsid'] },
    // ],
  }
);

module.exports = InstagramMessage;
