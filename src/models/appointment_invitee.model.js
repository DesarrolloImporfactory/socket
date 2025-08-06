const { DataTypes } = require('sequelize');
const { db } = require('../database/config');

const AppointmentInvitee = db.define(
  'appointment_invitees',
  {
    id: {
      type: DataTypes.BIGINT.UNSIGNED,
      primaryKey: true,
      autoIncrement: true,
    },
    appointment_id: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    name: { type: DataTypes.STRING(150), allowNull: true },
    email: { type: DataTypes.STRING(150), allowNull: true },
    phone: { type: DataTypes.STRING(30), allowNull: true },
    response_status: {
      type: DataTypes.ENUM('needsAction', 'accepted', 'declined', 'tentative'),
      allowNull: false,
      defaultValue: 'needsAction',
    },
    created_at: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: db.literal('CURRENT_TIMESTAMP'),
    },
  },
  {
    tableName: 'appointment_invitees',
    timestamps: false,
    freezeTableName: true,
  }
);

module.exports = AppointmentInvitee;
