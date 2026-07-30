const { DataTypes } = require('sequelize');
const { db } = require('../database/config');

/**
 * Quién atiende en una sede.
 *
 * Es lo que le da capacidad real a la agenda: dos citas a la misma hora conviven
 * si las atienden profesionales distintos. Poner nombres es opcional — "Cabina
 * 1/2/3" funciona como un cupo de tres simultáneas, "Sofía/Karla" deja que la
 * clienta elija con quién.
 *
 * A propósito NO son sub-usuarios: esos están limitados por plan y son para
 * quien usa el chat, no para quien atiende en la cabina.
 */
const ProfesionalesChatCenter = db.define(
  'profesionales_chat_center',
  {
    id: {
      type: DataTypes.INTEGER,
      autoIncrement: true,
      primaryKey: true,
    },
    id_configuracion: {
      type: DataTypes.BIGINT,
      allowNull: false,
    },
    // Una persona que trabaja en dos sucursales va dos veces: su disponibilidad
    // es por local, no global.
    id_establecimiento: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    nombre: {
      type: DataTypes.STRING(150),
      allowNull: false,
    },
    orden: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
    },
    activo: {
      type: DataTypes.TINYINT,
      allowNull: false,
      defaultValue: 1,
    },
    eliminado: {
      type: DataTypes.TINYINT,
      allowNull: false,
      defaultValue: 0,
    },
    fecha_creacion: {
      type: DataTypes.DATE,
      defaultValue: DataTypes.NOW,
    },
    fecha_actualizacion: {
      type: DataTypes.DATE,
      defaultValue: DataTypes.NOW,
    },
  },
  {
    tableName: 'profesionales_chat_center',
    timestamps: false,
    freezeTableName: true,
  },
);

module.exports = ProfesionalesChatCenter;
