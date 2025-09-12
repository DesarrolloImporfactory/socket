const { DataTypes } = require('sequelize');
const { db } = require('../database/config');

const MessengerMessage = db.define(
  'messenger_messages',
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

    psid: {
      type: DataTypes.STRING(32),
      allowNull: false,
    },

    direction: {
      type: DataTypes.ENUM('in', 'out'),
      allowNull: false,
    },

    mid: {
      type: DataTypes.STRING(100),
      allowNull: true,
      defaultValue: null,
    },

    text: {
      type: DataTypes.TEXT,
      allowNull: true,
      defaultValue: null,
    },

    attachments: {
      type: DataTypes.JSON,
      allowNull: true,
      defaultValue: null,
    },

    postback_payload: {
      type: DataTypes.TEXT,
      allowNull: true,
      defaultValue: null,
    },

    quick_reply_payload: {
      type: DataTypes.TEXT,
      allowNull: true,
      defaultValue: null,
    },

    sticker_id: {
      type: DataTypes.STRING(64),
      allowNull: true,
      defaultValue: null,
    },

    status: {
      type: DataTypes.ENUM(
        'received',
        'queued',
        'sent',
        'delivered',
        'read',
        'failed'
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

    meta: {
      type: DataTypes.JSON,
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
      defaultValue: db.literal('CURRENT_TIMESTAMP'),
    },

    id_encargado: {
      type: DataTypes.BIGINT,
      allowNull: true,
      defaultValue: null,
      comment:
        'sub_usuarios.id_sub_usuario que envió el mensaje (si fue humano)',
    },
  },
  {
    tableName: 'messenger_messages',
    timestamps: false, // usamos las columnas definidas arriba
    freezeTableName: true,
    indexes: [
      { name: 'ix_conv_time', fields: ['conversation_id', 'created_at'] },
      {
        name: 'ix_cfg_page_psid_time',
        fields: ['id_configuracion', 'page_id', 'psid', 'created_at'],
      },
      { name: 'ix_mid', fields: ['mid'] },
    ],
  }
);

module.exports = MessengerMessage;
