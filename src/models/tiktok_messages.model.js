const { DataTypes } = require('sequelize');
const { db } = require('../database/config');

const TikTokMessages = db.define(
  'tiktok_messages',
  {
    id: {
      type: DataTypes.BIGINT.UNSIGNED,
      primaryKey: true,
      autoIncrement: true,
    },
    conversation_id: { type: DataTypes.STRING(128), allowNull: false },
    direction: { type: DataTypes.ENUM('in', 'out'), allowNull: false },
    sender_external_id: { type: DataTypes.STRING(128), allowNull: true },
    text: { type: DataTypes.TEXT, allowNull: true },
    raw: { type: DataTypes.TEXT, allowNull: true },
    created_at: { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
  },
  {
    tableName: 'tiktok_messages',
    timestamps: false,
    indexes: [{ fields: ['conversation_id', 'created_at'] }],
  }
);

module.exports = TikTokMessages;
