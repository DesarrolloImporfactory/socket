const { DataTypes } = require('sequelize');
const { db } = require('../database/config');

const Calendar = db.define(
  'calendars',
  {
    id: {
      type: DataTypes.BIGINT.UNSIGNED,
      primaryKey: true,
      autoIncrement: true,
    },
    account_id: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    name: { type: DataTypes.STRING(120), allowNull: false },
    time_zone: {
      type: DataTypes.STRING(64),
      allowNull: false,
      defaultValue: 'America/Guayaquil',
    },
    color_hex: { type: DataTypes.CHAR(7), allowNull: true },
    is_active: { type: DataTypes.TINYINT, allowNull: false, defaultValue: 1 },
    created_by: { type: DataTypes.BIGINT.UNSIGNED, allowNull: true },
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
  },
  {
    tableName: 'calendars',
    timestamps: false,
    freezeTableName: true,
  }
);

module.exports = Calendar;
