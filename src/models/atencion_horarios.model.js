const { DataTypes } = require('sequelize');
const { db } = require('../database/config');

/**
 * Horario de atención de una conexión, para medir tiempos de respuesta.
 *
 * Los tiempos del dashboard de atención ("tarda en contestar", "desde que
 * abre el chat") y el cronómetro de la cabecera del chat solo cuentan lo que
 * cae dentro de este horario: un chat abierto el viernes a las 16:57 y
 * respondido el lunes a las 09:00 son 1h 03m, no 64 horas.
 *
 * Lo edita el administrador desde el dashboard. Sin fila, rige el horario
 * por defecto de atencion_horario.service.js (lunes a viernes, 08:00-17:00).
 * Tabla creada por db.sync.
 */
const AtencionHorarios = db.define(
  'atencion_horarios',
  {
    id_configuracion: {
      type: DataTypes.INTEGER,
      allowNull: false,
      primaryKey: true,
    },
    hora_inicio: { type: DataTypes.TINYINT, allowNull: false, defaultValue: 8 },
    hora_fin: { type: DataTypes.TINYINT, allowNull: false, defaultValue: 17 },
    /** Días hábiles, 0 = domingo … 6 = sábado, separados por coma. */
    dias: {
      type: DataTypes.STRING(20),
      allowNull: false,
      defaultValue: '1,2,3,4,5',
    },
    actualizado_por: { type: DataTypes.INTEGER, allowNull: true },
    updated_at: { type: DataTypes.DATE, allowNull: true },
  },
  {
    tableName: 'atencion_horarios',
    timestamps: false,
    freezeTableName: true,
  },
);

module.exports = AtencionHorarios;
