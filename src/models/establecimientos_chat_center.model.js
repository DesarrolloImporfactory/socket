const { DataTypes } = require('sequelize');
const { db } = require('../database/config');

/**
 * Sedes / sucursales de una configuración.
 *
 * Es el dato con el que el bot decide si una persona está dentro o fuera de
 * cobertura, y a qué agenda mandar la cita. Antes eso vivía como texto en el
 * prompt, así que dependía del criterio del modelo.
 */
const EstablecimientosChatCenter = db.define(
  'establecimientos_chat_center',
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
    nombre: {
      type: DataTypes.STRING(150),
      allowNull: false,
    },
    ciudad: {
      type: DataTypes.STRING(120),
      allowNull: false,
    },
    provincia: {
      type: DataTypes.STRING(120),
      allowNull: true,
    },
    direccion: {
      type: DataTypes.STRING(255),
      allowNull: true,
    },
    referencia: {
      type: DataTypes.STRING(255),
      allowNull: true,
    },
    // Enlace de Google Maps. El bot no puede leer la ubicación que comparte el
    // cliente, pero sí mandarle la del local para que llegue.
    google_maps_url: {
      type: DataTypes.STRING(500),
      allowNull: true,
    },
    telefono: {
      type: DataTypes.STRING(30),
      allowNull: true,
    },
    horario: {
      type: DataTypes.STRING(500),
      allowNull: true,
    },
    /* Horario estructurado. El campo `horario` de arriba es su resumen legible:
       como texto libre el bot tenía que interpretarlo y ofrecía citas los días
       que el local está cerrado. */
    horario_json: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    /* Traslado entre citas. Cuando se atiende EN el local, una cita termina a
       las 15:00 y la siguiente empieza a las 15:00: la persona ya está ahí. Pero
       cuando el que se mueve es quien atiende —un corredor que va de un inmueble
       a otro— agendar 15:00 y 15:30 es agendar algo a lo que no va a llegar.
       Son minutos que se reservan ANTES y DESPUÉS de cada cita.
       0 = citas pegadas, que es como venía funcionando. */
    buffer_minutos: {
      type: DataTypes.SMALLINT,
      allowNull: false,
      defaultValue: 0,
    },
    /* Cuánto se necesita de aviso. Sin esto el bot ofrece las 16:00 cuando son
       las 15:40, y ni el cliente ni quien atiende llegan. */
    anticipacion_minima_horas: {
      type: DataTypes.SMALLINT,
      allowNull: false,
      defaultValue: 0,
    },
    // Tope de citas por día. NULL = sin tope.
    max_citas_dia: {
      type: DataTypes.SMALLINT,
      allowNull: true,
    },
    // calendars.id — la agenda de esta sede. NULL = la cuenta tiene una sola.
    id_calendario: {
      type: DataTypes.BIGINT.UNSIGNED,
      allowNull: true,
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
    tableName: 'establecimientos_chat_center',
    timestamps: false,
    freezeTableName: true,
  },
);

module.exports = EstablecimientosChatCenter;
