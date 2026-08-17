const { DataTypes } = require('sequelize');
const { db } = require('../database/config');

/**
 * Una cita que todavía no existe.
 *
 * El bot puede agendar solo —y para muchos negocios eso es exactamente lo que
 * se quiere— pero hay agendas donde no: quien atiende puede estar durmiendo, en
 * una reunión o manejando, y enterarse de que tiene una visita a las 15:00
 * cuando ya son las 14:40. Con `modo: 'solicitud'` en la acción `agendar_cita`,
 * el bot hace todo su trabajo (levanta el interés, el dato de contacto, qué
 * quiere ver y cuándo le viene bien) pero no toca el calendario: deja esto y
 * mueve la tarjeta a una columna donde se ve de un vistazo.
 *
 * No es una cita con estado "pendiente" a propósito: una cita ocupa un cupo,
 * aparece en el calendario, la cuentan los topes y la miran los crons de
 * recordatorio. Esto no es nada de eso hasta que una persona lo confirma.
 *
 * ── OJO: este modelo está a propósito FUERA de initModels ──
 * La tabla la crea `tablero_inmobiliario_migration.sql` y solo eso. Si se
 * engancha acá, `db.sync({force:false})` la crearía desde cualquier corrida
 * local —dev y producción comparten base— y con los índices de menos; después
 * el CREATE TABLE de la migración falla y queda una tabla a medias en
 * producción. El modelo vive acá como documentación del shape y para quien
 * quiera consultarla con Sequelize; los servicios usan SQL crudo.
 */
const CitasSolicitudes = db.define(
  'citas_solicitudes',
  {
    id: {
      type: DataTypes.BIGINT.UNSIGNED,
      autoIncrement: true,
      primaryKey: true,
    },
    id_configuracion: { type: DataTypes.BIGINT, allowNull: false },
    id_cliente: { type: DataTypes.INTEGER, allowNull: true },
    // Qué quiere ver. NULL si el nombre no coincidió con nada del catálogo.
    id_producto: { type: DataTypes.INTEGER, allowNull: true },
    // Oficina que lo gestiona: de ahí sale la agenda cuando se confirma.
    id_establecimiento: { type: DataTypes.INTEGER, allowNull: true },
    nombre: { type: DataTypes.STRING(150), allowNull: true },
    telefono: { type: DataTypes.STRING(30), allowNull: true },
    correo: { type: DataTypes.STRING(150), allowNull: true },
    servicio: { type: DataTypes.STRING(255), allowNull: true },
    /* La franja va por duplicado a propósito. `inicio_sugerido` es lo que se
       pudo interpretar y sirve para precargar el formulario; `preferencia_texto`
       es lo que la persona dijo de verdad ("el sábado en la mañana"). Cuando lo
       interpretado sale mal, el texto es lo que salva la cita. */
    preferencia_texto: { type: DataTypes.STRING(255), allowNull: true },
    inicio_sugerido: { type: DataTypes.DATE, allowNull: true },
    duracion_minutos: { type: DataTypes.SMALLINT, allowNull: true },
    estado: {
      type: DataTypes.ENUM('pendiente', 'agendada', 'descartada'),
      allowNull: false,
      defaultValue: 'pendiente',
    },
    id_cita: { type: DataTypes.BIGINT.UNSIGNED, allowNull: true },
    notas: { type: DataTypes.TEXT, allowNull: true },
    atendida_por: { type: DataTypes.BIGINT.UNSIGNED, allowNull: true },
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
    tableName: 'citas_solicitudes',
    timestamps: false,
    freezeTableName: true,
  },
);

module.exports = CitasSolicitudes;
