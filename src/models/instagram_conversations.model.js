const { DataTypes } = require('sequelize');
const { db } = require('../database/config');

const InstagramConversation = db.define(
  'instagram_conversations',
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

    page_id: {
      type: DataTypes.STRING(32),
      allowNull: false,
    },

    igsid: {
      type: DataTypes.STRING(32),
      allowNull: false,
    },

    status: {
      type: DataTypes.ENUM('open', 'closed'),
      allowNull: false,
      defaultValue: 'open',
    },

    unread_count: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
    },

    first_contact_at: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: db.literal('CURRENT_TIMESTAMP'),
    },

    last_message_at: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: db.literal('CURRENT_TIMESTAMP'),
    },

    last_incoming_at: {
      type: DataTypes.DATE,
      allowNull: true,
      defaultValue: null,
    },

    last_outgoing_at: {
      type: DataTypes.DATE,
      allowNull: true,
      defaultValue: null,
    },

    customer_name: {
      type: DataTypes.STRING(255),
      allowNull: true,
      defaultValue: null,
    },

    profile_pic_url: {
      type: DataTypes.TEXT, // coincide con TEXT en MySQL
      allowNull: true,
      defaultValue: null,
    },

    updated_at: {
      type: DataTypes.DATE,
      allowNull: false,
      // La columna en MySQL tiene ON UPDATE CURRENT_TIMESTAMP
      defaultValue: db.literal('CURRENT_TIMESTAMP'),
    },

    id_encargado: {
      type: DataTypes.BIGINT,
      allowNull: true,
      defaultValue: null,
    },

    id_departamento: {
      type: DataTypes.BIGINT,
      allowNull: true,
      defaultValue: null,
    },
  },
  {
    tableName: 'instagram_conversations',
    timestamps: false, // usamos las columnas reales de la tabla
    freezeTableName: true,
    indexes: [
      // UNIQUE KEY `ux_cfg_page_igsid` (`id_configuracion`,`page_id`,`igsid`)
      {
        name: 'ux_cfg_page_igsid',
        unique: true,
        fields: ['id_configuracion', 'page_id', 'igsid'],
      },
      // KEY `ix_last_message_at` (`id_configuracion`,`last_message_at`)
      {
        name: 'ix_last_message_at',
        fields: ['id_configuracion', 'last_message_at'],
      },
      // KEY `ix_page_igsid` (`page_id`,`igsid`)
      {
        name: 'ix_page_igsid',
        fields: ['page_id', 'igsid'],
      },
      // KEY `ix_ig_cfg_encargado` (`id_configuracion`,`id_encargado`)
      {
        name: 'ix_ig_cfg_encargado',
        fields: ['id_configuracion', 'id_encargado'],
      },
    ],
  }
);

module.exports = InstagramConversation;
