const { DataTypes } = require('sequelize');
const { db } = require('../database/config');

const TikTokConversations = db.define(
  'tiktok_conversations',
  {
    id: {
      type: DataTypes.BIGINT.UNSIGNED,
      primaryKey: true,
      autoIncrement: true,
    },
    conversation_id: {
      type: DataTypes.STRING(128),
      allowNull: false,
      unique: true,
    },
    customer_external_id: { type: DataTypes.STRING(128), allowNull: true },
    id_cliente_chat_center: { type: DataTypes.BIGINT, allowNull: true },
    last_message_at: { type: DataTypes.DATE, allowNull: true },
    metadata: { type: DataTypes.TEXT, allowNull: true },
    created_at: { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
    updated_at: { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
  },
  { tableName: 'tiktok_conversations', timestamps: false }
);

module.exports = TikTokConversations;
