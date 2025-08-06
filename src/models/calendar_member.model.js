const { DataTypes } = require('sequelize');
const { db } = require('../database/config');

const CalendarMember = db.define(
  'calendar_members',
  {
    id: {
      type: DataTypes.BIGINT.UNSIGNED,
      primaryKey: true,
      autoIncrement: true,
    },
    calendar_id: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    user_id: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    role: {
      type: DataTypes.ENUM('owner', 'editor', 'viewer'),
      allowNull: false,
      defaultValue: 'editor',
    },
    color_hex: { type: DataTypes.CHAR(7), allowNull: true },
    created_at: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: db.literal('CURRENT_TIMESTAMP'),
    },
  },
  {
    tableName: 'calendar_members',
    timestamps: false,
    freezeTableName: true,
  }
);

module.exports = CalendarMember;
