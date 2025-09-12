const { DataTypes } = require('sequelize');
const { db } = require('../database/config');

const MessengerConversation = db.define(
  'messenger_conversations',
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

    psid: {
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

    updated_at: {
      type: DataTypes.DATE,
      allowNull: false,
      // La columna ya tiene ON UPDATE CURRENT_TIMESTAMP en MySQL
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
    tableName: 'messenger_conversations',
    timestamps: false, // usamos las columnas de la tabla (no createdAt/updatedAt de Sequelize)
    freezeTableName: true,
    indexes: [
      // UNIQUE KEY `ux_cfg_page_psid` (`id_configuracion`,`page_id`,`psid`)
      {
        name: 'ux_cfg_page_psid',
        unique: true,
        fields: ['id_configuracion', 'page_id', 'psid'],
      },
      // KEY `ix_last_message_at` (`id_configuracion`,`last_message_at`)
      {
        name: 'ix_last_message_at',
        fields: ['id_configuracion', 'last_message_at'],
      },
      // KEY `ix_page_psid` (`page_id`,`psid`)
      {
        name: 'ix_page_psid',
        fields: ['page_id', 'psid'],
      },
      // KEY `ix_mc_cfg_encargado` (`id_configuracion`,`id_encargado`)
      {
        name: 'ix_mc_cfg_encargado',
        fields: ['id_configuracion', 'id_encargado'],
      },
    ],
  }
);

module.exports = MessengerConversation;
