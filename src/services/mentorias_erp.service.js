/* -----------------------------------------------------------------------
   MENTORÍAS DEL ERP → agenda del chatcenter

   El ERP (imporsuitpro) tiene su propio módulo de mentorías de
   implementación: ahí vive la habilitación del alumno, la grilla de 20
   minutos y la regla de "una sesión por alumno". Lo que NO tiene es la
   integración con Google Calendar, que acá ya está resuelta y en uso
   (OAuth, push/pull, Meet, invitaciones, recordatorios).

   Este servicio es el punto por donde el ERP entra a esa agenda. No
   reimplementa nada: arma el payload y llama a `appointments.service`, el
   mismo que usa el calendario del front. Todo lo que ya funciona para una
   cita creada a mano —el evento en Google, el Meet, el correo al invitado—
   funciona igual para una mentoría, porque es literalmente el mismo camino.

   Qué calendario y qué mentores se usan sale del `.env`, no del cuerpo de la
   petición: quien llama demuestra que es el ERP, no elige a nombre de quién
   escribe en la agenda del equipo.
   ----------------------------------------------------------------------- */
const { Op } = require('sequelize');
const Appointment = require('../models/appointment.model');
const AppError = require('../utils/appError');
const { db } = require('../database/config');
const svc = require('./appointments.service');

/* Estados que ocupan lugar. Mismo criterio que `assertNoOverlap`: lo
   completado ya pasó y lo cancelado liberó el espacio. */
const ESTADOS_OCUPAN = ['Agendado', 'Confirmado', 'Bloqueado'];

/**
 * Configuración de la integración. Se lee en cada llamada para que cambiar de
 * mentor sea editar el `.env` y reiniciar, sin tocar código.
 *
 * `MENTORIA_MENTORES` es una lista por una razón concreta: hoy atiende uno, y
 * el día que sean tres el mismo horario admite tres mentorías. La capacidad
 * del sistema es cuánta gente atiende, y eso es un dato de operación, no una
 * constante del programa.
 */
function config() {
  const calendarId = Number(process.env.MENTORIA_CALENDAR_ID || 0);
  const mentores = String(process.env.MENTORIA_MENTORES || '')
    .split(',')
    .map((s) => Number(String(s).trim()))
    .filter((n) => Number.isInteger(n) && n > 0);
  const creadoPor = Number(process.env.MENTORIA_CREATED_BY || 0) || null;
  const zona = String(process.env.MENTORIA_TZ || 'America/Guayaquil');

  /* ¿Ocupa el calendario entero o sólo lo de los mentores?
     Depende de un detalle de cómo está montada la cuenta: si todos los
     asesores vincularon el MISMO Gmail —que es el caso del calendario del
     equipo hoy—, la cita de cualquiera de ellos aparece en el mismo Google
     Calendar donde va a caer la mentoría, aunque el sistema no la considere
     un choque. Ahí lo honesto es tachar el espacio.
     Cuando cada mentor tenga su propia cuenta de Google, esto pasa a 0 y la
     capacidad vuelve a ser por persona. */
  const bloqueaTodo = String(process.env.MENTORIA_BLOQUEA_TODO ?? '1') !== '0';

  if (!calendarId || !mentores.length) {
    throw new AppError(
      'Faltan MENTORIA_CALENDAR_ID o MENTORIA_MENTORES en el entorno.',
      503,
    );
  }

  return { calendarId, mentores, creadoPor, zona, bloqueaTodo };
}

/* Las columnas start_utc/end_utc guardan strings UTC ('YYYY-MM-DD HH:MM:SS').
   Comparar contra un Date haría que mysql2 lo serialice con el timezone de la
   conexión y la consulta quedaría corrida cinco horas. Mismo criterio que
   `toUtcMysqlParam` en appointments.service. */
function aUtcMysql(v) {
  const d = v instanceof Date ? v : new Date(v);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

/* Valor de la columna (UTC) → ISO con 'Z', que es lo que el ERP entiende. */
function aIso(v) {
  if (!v) return null;
  if (v instanceof Date) return v.toISOString();
  const s = String(v).replace(' ', 'T');
  return /[zZ]|[+-]\d{2}:\d{2}$/.test(s) ? s : s + 'Z';
}

function fechaValida(v, campo) {
  const d = new Date(v);
  if (!v || Number.isNaN(d.getTime())) {
    throw new AppError('El campo `' + campo + '` no es una fecha válida.', 400);
  }
  return d;
}

/* ╔═══════════════════════════════════════════════════════════════════════╗
   ║ OCUPACIÓN                                                             ║
   ╚═══════════════════════════════════════════════════════════════════════╝ */
/**
 * Qué tienen tomado los mentores en un rango.
 *
 * El ERP dibuja su grilla de 20 minutos y necesita saber qué tachar. Se
 * devuelven los rangos ocupados por mentor —no un simple "libre/ocupado"—
 * porque con varios mentores un horario sigue disponible mientras quede uno
 * suelto, y esa cuenta la hace quien arma la grilla.
 *
 * Un 'Bloqueado' sin encargado (feriado, cierre) cierra el día para todos, así
 * que se reparte a cada mentor: para la grilla es como si todos lo tuvieran.
 * Lo mismo pasa con TODA cita ajena cuando `bloqueaTodo` está encendido — ver
 * la nota en `config()`.
 */
async function ocupacion({ desde, hasta }) {
  const { calendarId, mentores, bloqueaTodo } = config();

  const inicio = aUtcMysql(fechaValida(desde, 'desde'));
  const fin = aUtcMysql(fechaValida(hasta, 'hasta'));
  if (inicio >= fin) {
    throw new AppError('El campo `desde` debe ser anterior a `hasta`.', 400);
  }

  const where = {
    calendar_id: calendarId,
    status: { [Op.in]: ESTADOS_OCUPAN },
    start_utc: { [Op.lt]: fin },
    end_utc: { [Op.gt]: inicio },
  };

  if (!bloqueaTodo) {
    where[Op.or] = [
      { assigned_user_id: { [Op.in]: mentores } },
      { assigned_user_id: { [Op.is]: null }, status: 'Bloqueado' },
    ];
  }

  const filas = await Appointment.findAll({
    where,
    attributes: ['id', 'assigned_user_id', 'status', 'start_utc', 'end_utc'],
    order: [['start_utc', 'ASC']],
    raw: true,
  });

  const ocupado = [];
  for (const f of filas) {
    const rango = { inicio: aIso(f.start_utc), fin: aIso(f.end_utc) };
    const suyo = f.assigned_user_id != null && mentores.includes(Number(f.assigned_user_id));

    if (suyo) {
      ocupado.push({ mentor: Number(f.assigned_user_id), ...rango });
    } else {
      // Cita de otro asesor, o cierre general: le pesa a todos los mentores,
      // porque el espacio queda pisado en el calendario compartido.
      for (const m of mentores) ocupado.push({ mentor: m, ...rango });
    }
  }

  return { mentores, ocupado };
}

/* ╔═══════════════════════════════════════════════════════════════════════╗
   ║ CREAR                                                                 ║
   ╚═══════════════════════════════════════════════════════════════════════╝ */
/**
 * Cuántas citas tiene cada mentor ese día, de menos a más ocupado.
 *
 * Sirve para repartir: entre dos mentores libres a la misma hora, atiende el
 * que va más descargado. Con un solo mentor configurado la consulta sobra,
 * pero cuesta poco y evita que "aumentar mentores" sea rehacer esta función.
 */
async function cargaDelDia(calendarId, mentores, inicioUtc) {
  const dia = String(inicioUtc).slice(0, 10);

  const filas = await db.query(
    `SELECT assigned_user_id AS mentor, COUNT(*) AS total
       FROM appointments
      WHERE calendar_id = :calendarId
        AND assigned_user_id IN (:mentores)
        AND status IN (:estados)
        AND DATE(start_utc) = :dia
      GROUP BY assigned_user_id`,
    {
      replacements: { calendarId, mentores, estados: ESTADOS_OCUPAN, dia },
      type: db.QueryTypes.SELECT,
    },
  );

  const porMentor = new Map(
    filas.map((f) => [Number(f.mentor), Number(f.total)]),
  );

  return mentores
    .slice()
    .sort((a, b) => (porMentor.get(a) || 0) - (porMentor.get(b) || 0));
}

/**
 * Registra la mentoría en la agenda y la publica en Google.
 *
 * A quién se le asigna lo decide acá y no el ERP: el choque de horarios lo
 * detecta `assertNoOverlap` dentro de una operación que ya está corriendo, y
 * si el ERP eligiera al mentor de antemano, entre su consulta de ocupación y
 * este insert cabe otra cita. Probar mentor por mentor cierra esa ventana.
 *
 * `create_meet: true` hace que el push a Google sea síncrono y devuelva el
 * enlace del Meet en la misma respuesta — el alumno lo ve apenas agenda, sin
 * tener que refrescar.
 */
async function crear({ inicio, fin, titulo, descripcion, alumno }) {
  const { calendarId, mentores, creadoPor, zona } = config();

  const inicioDate = fechaValida(inicio, 'inicio');
  const finDate = fechaValida(fin, 'fin');
  if (finDate <= inicioDate) {
    throw new AppError('El campo `fin` debe ser posterior a `inicio`.', 400);
  }
  if (!titulo || !String(titulo).trim()) {
    throw new AppError('El campo `titulo` es obligatorio.', 400);
  }

  const invitados = [];
  if (alumno && (alumno.email || alumno.nombre || alumno.telefono)) {
    invitados.push({
      name: alumno.nombre || null,
      email: alumno.email || null,
      phone: alumno.telefono || null,
    });
  }

  const candidatos = await cargaDelDia(calendarId, mentores, inicioDate);
  let ultimoChoque = null;

  for (const mentor of candidatos) {
    try {
      const appt = await svc.createAppointment(
        {
          calendar_id: calendarId,
          title: String(titulo).slice(0, 200),
          description: descripcion || null,
          status: 'Agendado',
          assigned_user_id: mentor,
          start: inicio,
          end: fin,
          booked_tz: zona,
          create_meet: true,
          invitees: invitados,
          created_by_user_id: creadoPor,
        },
        creadoPor,
      );

      return {
        appointment_id: Number(appt.id),
        mentor_id: mentor,
        meeting_url: appt.meeting_url || null,
        google_event_id: appt.google_event_id || null,
        sync_error: appt.last_sync_error || null,
      };
    } catch (e) {
      // 409 es "este mentor ya tiene algo a esa hora": se prueba el siguiente.
      // Cualquier otra cosa (400, fallo de base) es un problema real y sube.
      if (e?.statusCode === 409) {
        ultimoChoque = e;
        continue;
      }
      throw e;
    }
  }

  throw new AppError(
    mentores.length > 1
      ? 'Todos los mentores tienen ocupado ese horario.'
      : ultimoChoque?.message || 'El mentor ya tiene una cita en ese horario.',
    409,
  );
}

/* ╔═══════════════════════════════════════════════════════════════════════╗
   ║ CANCELAR                                                              ║
   ╚═══════════════════════════════════════════════════════════════════════╝ */
/**
 * Libera el espacio y borra el evento en Google.
 *
 * Se comprueba que la cita sea del calendario configurado antes de tocarla: el
 * token del ERP autoriza a manejar mentorías, no a cancelar la cita de
 * cualquier cuenta del chatcenter que comparta la numeración.
 */
async function cancelar({ appointmentId }) {
  const { calendarId } = config();

  const appt = await Appointment.findByPk(appointmentId, {
    attributes: ['id', 'calendar_id', 'status'],
    raw: true,
  });
  if (!appt) throw new AppError('Cita no encontrada.', 404);
  if (Number(appt.calendar_id) !== calendarId) {
    throw new AppError('Esa cita no pertenece a la agenda de mentorías.', 403);
  }
  if (appt.status === 'Cancelado') {
    return { appointment_id: Number(appointmentId), ya_estaba: true };
  }

  await svc.cancelAppointment(appointmentId);
  return { appointment_id: Number(appointmentId), ya_estaba: false };
}

module.exports = { ocupacion, crear, cancelar, config };
