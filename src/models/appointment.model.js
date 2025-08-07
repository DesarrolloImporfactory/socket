const { DataTypes } = require('sequelize');
const { db } = require('../database/config');

const Appointment = db.define(
  'appointments',
  {
    id: {
      type: DataTypes.BIGINT.UNSIGNED,
      primaryKey: true,
      autoIncrement: true,
    },
    calendar_id: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    title: { type: DataTypes.STRING(200), allowNull: false },
    description: { type: DataTypes.TEXT, allowNull: true },
    status: {
      type: DataTypes.ENUM(
        'Agendado',
        'Confirmado',
        'Completado',
        'Cancelado',
        'Bloqueado'
      ),
      allowNull: false,
      defaultValue: 'Agendado',
    },
    assigned_user_id: { type: DataTypes.BIGINT.UNSIGNED, allowNull: true },
    contact_id: { type: DataTypes.BIGINT.UNSIGNED, allowNull: true },
    start_utc: { type: DataTypes.DATE, allowNull: false },
    end_utc: { type: DataTypes.DATE, allowNull: false },
    booked_tz: {
      type: DataTypes.STRING(64),
      allowNull: false,
      defaultValue: 'America/Guayaquil',
    },
    location_text: { type: DataTypes.STRING(255), allowNull: true },
    meeting_url: { type: DataTypes.STRING(255), allowNull: true },
    created_by_user_id: { type: DataTypes.BIGINT.UNSIGNED, allowNull: true },
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
    tableName: 'appointments',
    timestamps: false,
    freezeTableName: true,
  }
);

module.exports = Appointment;
