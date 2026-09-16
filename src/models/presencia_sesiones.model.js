const { DataTypes } = require('sequelize');
const { db } = require('../database/config');

/**
 * Un tramo conectado de un sub-usuario en el namespace /presence.
 *
 * Hasta el 2026-09-16 la presencia vivía solo en memoria: no había forma de
 * decirle a un cliente cuánto tiempo estuvo conectada cada persona de su
 * equipo. Una fila = un tramo conectado. `fin` se toca cada 5 min mientras el
 * socket siga vivo (sockets/presence/presenceSessions.js), así un reinicio del
 * server no deja tramos abiertos infinitos. Tabla creada en prod ese mismo
 * día; db.sync la crea igual si faltara.
 */
const PresenciaSesiones = db.define(
  'presencia_sesiones',
  {
    id: {
      type: DataTypes.BIGINT.UNSIGNED,
      allowNull: false,
      autoIncrement: true,
      primaryKey: true,
    },
    id_sub_usuario: { type: DataTypes.INTEGER, allowNull: false },
    id_usuario: { type: DataTypes.INTEGER, allowNull: true },
    inicio: { type: DataTypes.DATE, allowNull: false },
    fin: { type: DataTypes.DATE, allowNull: true },
    duracion_seg: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
    cerrada: { type: DataTypes.TINYINT, allowNull: false, defaultValue: 0 },
  },
  {
    tableName: 'presencia_sesiones',
    timestamps: false,
    freezeTableName: true,
    indexes: [
      { fields: ['id_sub_usuario', 'inicio'] },
      { fields: ['id_usuario', 'inicio'] },
    ],
  },
);

module.exports = PresenciaSesiones;
