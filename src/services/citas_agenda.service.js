'use strict';

/* Alta de una cita, en un solo lugar.
   ─────────────────────────────────────────────────────────────
   Hay dos caminos que terminan en la misma cita: el bot cuando agenda solo, y
   una persona cuando confirma una solicitud desde el panel. Elegir la agenda,
   repartir a quien atiende, respetar el traslado y decidir la dirección son las
   mismas decisiones en los dos casos, y son justo las que se ven cuando salen
   mal: una visita en la sucursal equivocada, dos citas encimadas, el corredor
   esperando en la oficina.

   Por eso viven acá y no dentro del parser de kanban_ia.service. Ese archivo
   sigue haciendo lo suyo —leer el bloque que escribió el modelo— y le pasa los
   datos ya limpios a esta función. */

const path = require('path');
const fs = require('fs').promises;
const moment = require('moment-timezone');

const { db } = require('../database/config');
const servicioAppointments = require('./appointments.service');
const {
  enviarUbicacionWhatsapp,
} = require('../utils/webhook_whatsapp/enviarUbicacion');

const logsDir = path.join(process.cwd(), './src/logs/logs_meta');

async function log(msg) {
  try {
    await fs.mkdir(logsDir, { recursive: true });
    await fs.appendFile(
      path.join(logsDir, 'debug_log.txt'),
      `[${new Date().toISOString()}] [citas_agenda] ${msg}\n`,
    );
  } catch (_) {
    /* el log no puede tumbar una cita */
  }
}

/* Credenciales de WhatsApp de la cuenta. Se leen acá y no se piden por
   parámetro porque los dos caminos que crean citas —el bot y la confirmación
   manual— las tienen en lugares distintos, y el que confirma desde el panel no
   tiene ninguna a mano. */
async function credencialesWhatsapp(id_configuracion) {
  const [cfg] = await db.query(
    `SELECT token, id_telefono FROM configuraciones WHERE id = ? LIMIT 1`,
    { replacements: [id_configuracion], type: db.QueryTypes.SELECT },
  );
  if (!cfg?.token || !cfg?.id_telefono) return null;
  return { accessToken: cfg.token, business_phone_id: cfg.id_telefono };
}

/**
 * Quién atiende esta cita.
 *
 * Sin esto, todas las citas caían sobre el mismo sub-usuario administrador y un
 * centro con tres esteticistas solo podía recibir UNA cita por hora: la segunda
 * moría con "el encargado ya tiene una cita". Con profesionales cargados, la
 * capacidad la da cuánta gente atiende.
 *
 * Devuelve el id, `null` si la sede no tiene profesionales cargados (y entonces
 * todo funciona como antes), o `{ error }` si no queda nadie libre.
 *
 * Si se pidió a alguien en particular —porque el cliente lo pidió— se respeta o
 * se falla: cambiarlo en silencio por otra persona es peor que no agendar, el
 * cliente llegaría esperando a alguien que no lo va a atender.
 */
async function elegirProfesionalLibre({
  id_configuracion,
  establecimiento,
  calendarId,
  inicio_utc,
  fin_utc,
  pedido,
  buffer_minutos = 0,
}) {
  if (!establecimiento?.id) return null;

  const profesionales = await db.query(
    `SELECT id, nombre FROM profesionales_chat_center
      WHERE id_configuracion = ? AND id_establecimiento = ?
        AND activo = 1 AND eliminado = 0
      ORDER BY orden ASC, id ASC`,
    {
      replacements: [id_configuracion, establecimiento.id],
      type: db.QueryTypes.SELECT,
    },
  );
  if (!profesionales.length) return null;

  /* Ocupados en ese rango. 'Bloqueado' sin profesional cierra el local entero.

     El rango se agranda con los minutos de traslado de la sede: si el corredor
     está mostrando un inmueble a las 15:00 y del otro lado de la ciudad hay
     otro a las 15:45, la agenda se ve libre pero él no llega. Con buffer 0
     —toda cuenta que atiende en su local— la consulta es la de siempre. */
  const colchon = Math.max(0, Number(buffer_minutos) || 0);
  const ocupados = await db.query(
    `SELECT DISTINCT id_profesional FROM appointments
      WHERE calendar_id = ?
        AND status IN ('Agendado', 'Confirmado', 'Bloqueado')
        AND start_utc < DATE_ADD(?, INTERVAL ? MINUTE)
        AND end_utc   > DATE_SUB(?, INTERVAL ? MINUTE)
        AND id_profesional IS NOT NULL`,
    {
      replacements: [calendarId, fin_utc, colchon, inicio_utc, colchon],
      type: db.QueryTypes.SELECT,
    },
  );
  const ocupadosSet = new Set(ocupados.map((o) => Number(o.id_profesional)));

  const norm = (s) =>
    String(s || '')
      .toLowerCase()
      .normalize('NFD')
      .replace(/\p{M}/gu, '')
      .replace(/\s+/g, ' ')
      .trim();

  if (pedido) {
    const buscado = norm(pedido);
    const elegido =
      profesionales.find((p) => norm(p.nombre) === buscado) ||
      profesionales.find(
        (p) =>
          norm(p.nombre).includes(buscado) || buscado.includes(norm(p.nombre)),
      );
    if (!elegido) {
      return {
        error: `no existe "${pedido}" entre quienes atienden en la sede`,
      };
    }
    if (ocupadosSet.has(Number(elegido.id))) {
      return {
        error:
          `${elegido.nombre} ya tiene una cita a esa hora` +
          (colchon ? ` (o dentro de los ${colchon} min de traslado)` : ''),
      };
    }
    return elegido.id;
  }

  const libre = profesionales.find((p) => !ocupadosSet.has(Number(p.id)));
  if (!libre) {
    return {
      error:
        `no queda nadie libre en "${establecimiento.nombre}" a esa hora ` +
        `(${profesionales.length} atienden)` +
        (colchon ? ` · se reservan ${colchon} min de traslado` : ''),
    };
  }
  return libre.id;
}

/**
 * La agenda donde cae la cita.
 *
 * Se crea al vuelo si no existe. Antes esto se abandonaba con un log y la cita
 * no se creaba nunca; y como el cambio de columna corre por separado, la
 * tarjeta igual se movía a "Cita agendada": quedaba una cita fantasma, visible
 * en el tablero e inexistente en el calendario. Pasaba siempre en cuentas
 * recién montadas, porque la fila de `calendars` solo nacía cuando alguien
 * abría la pantalla de Calendario.
 */
async function resolverCalendario({ id_configuracion, establecimiento, id_usuario }) {
  if (establecimiento?.id_calendario) {
    const [c] = await db.query(`SELECT id FROM calendars WHERE id = ? LIMIT 1`, {
      replacements: [establecimiento.id_calendario],
      type: db.QueryTypes.SELECT,
    });
    if (c?.id) return c.id;
  }

  const [c] = await db.query(
    `SELECT id FROM calendars WHERE account_id = ? AND is_active = 1
      ORDER BY id ASC LIMIT 1`,
    { replacements: [id_configuracion], type: db.QueryTypes.SELECT },
  );
  if (c?.id) return c.id;

  const { ensureDefaultCalendar } = require('./calendars.service');
  const creado = await ensureDefaultCalendar({
    account_id: Number(id_configuracion),
    name: 'Agenda principal',
    created_by: id_usuario,
  });
  await log(
    `📅 la configuración ${id_configuracion} no tenía agenda; se creó la ${creado?.id}`,
  );
  return creado?.id || null;
}

/**
 * Crea la cita.
 *
 * @param {object} p
 * @param {number} p.id_configuracion
 * @param {object|null} p.establecimiento  sede que pone la agenda y el traslado
 * @param {object|null} p.item             ítem del catálogo, si la cita es en él
 * @param {'sede'|'item'} p.lugar_cita
 * @param {string} p.inicio_utc  ISO
 * @param {string} p.fin_utc     ISO
 * @returns {Promise<{ok:boolean, id?:number, motivo?:string, repetida?:boolean, ubicacion?:string}>}
 */
async function crearCitaAgendada({
  id_configuracion,
  establecimiento = null,
  item = null,
  lugar_cita = 'sede',
  nombre = '',
  telefono = '',
  correo = '',
  servicio = '',
  inicio_utc,
  fin_utc,
  profesional_pedido = null,
  descripcion = '',
}) {
  const [usuario] = await db.query(
    `SELECT sb.id_sub_usuario, sb.id_usuario
     FROM configuraciones c
     INNER JOIN sub_usuarios_chat_center sb ON sb.id_usuario = c.id_usuario
     WHERE c.id = ? AND sb.rol = 'administrador' LIMIT 1`,
    { replacements: [id_configuracion], type: db.QueryTypes.SELECT },
  );

  if (!usuario) {
    await log(
      `❌ la configuración ${id_configuracion} no tiene sub-usuario administrador; la cita NO se creó`,
    );
    return { ok: false, motivo: 'sin sub-usuario administrador' };
  }

  let calendarId;
  try {
    calendarId = await resolverCalendario({
      id_configuracion,
      establecimiento,
      id_usuario: usuario.id_usuario,
    });
  } catch (e) {
    await log(`❌ no se pudo crear la agenda: ${e.message}`);
    return { ok: false, motivo: `no se pudo crear la agenda: ${e.message}` };
  }

  if (!calendarId) {
    return { ok: false, motivo: 'no se pudo resolver la agenda' };
  }

  /* Minutos de traslado de esta sede. Es lo que separa una agenda de local —una
     cita termina y la siguiente empieza, la persona ya está ahí— de una agenda
     que se mueve por la ciudad. Vale 0 en toda cuenta que no lo haya
     configurado, así que nada cambia para quien atiende en su local. */
  const bufferSede = Math.max(0, Number(establecimiento?.buffer_minutos) || 0);

  const idProfesional = await elegirProfesionalLibre({
    id_configuracion,
    establecimiento,
    calendarId,
    inicio_utc,
    fin_utc,
    pedido: profesional_pedido,
    buffer_minutos: bufferSede,
  });

  if (idProfesional && idProfesional.error) {
    await log(`❌ ${idProfesional.error}`);
    return { ok: false, motivo: idProfesional.error };
  }

  /* Cita repetida. El bot vuelve a escribir el bloque cuando la persona
     responde "sí" o "perfecto" después de confirmada —pasa sobre todo en la
     columna "Cita agendada", que también puede agendar para reprogramar— y eso
     creaba una segunda cita idéntica: dos cupos ocupados y la sede esperando a
     alguien dos veces. Si ya existe una en ese mismo horario para este contacto,
     se da por hecha. */
  const [yaExiste] = await db.query(
    `SELECT ap.id
       FROM appointments ap
       JOIN appointment_invitees inv ON inv.appointment_id = ap.id
      WHERE ap.calendar_id = ?
        AND ap.start_utc = ?
        AND ap.status IN ('Agendado', 'Confirmado')
        AND RIGHT(REGEXP_REPLACE(inv.phone, '[^0-9]', ''), 9)
            = RIGHT(REGEXP_REPLACE(?, '[^0-9]', ''), 9)
      LIMIT 1`,
    {
      replacements: [
        calendarId,
        moment.utc(inicio_utc).format('YYYY-MM-DD HH:mm:ss'),
        telefono || '',
      ],
      type: db.QueryTypes.SELECT,
    },
  );

  if (yaExiste) {
    await log(
      `♻️ ${nombre} ya tenía la cita ${yaExiste.id} a esa misma hora; no se duplica`,
    );
    return { ok: true, id: yaExiste.id, repetida: true };
  }

  /* ── Dónde se hace la cita ──────────────────────────────────────
     Por defecto, la sede: es lo de siempre y lo correcto para una clínica o un
     centro estético. Con `lugar_cita = 'item'` el lugar es la dirección del
     propio ítem, porque a un inmueble se va a verlo donde está.

     La dirección sale del catálogo, nunca de lo que escriba el modelo: una
     dirección inventada manda a la persona a otro barrio y ahí ya no hay manera
     de arreglarlo. */
  const ubicacionItem =
    lugar_cita === 'item' && String(item?.direccion || '').trim()
      ? [item.nombre, item.direccion, item.sector || item.ciudad]
          .filter(Boolean)
          .join(' — ')
          .slice(0, 255)
      : null;

  /* Sin dirección cargada la cita igual se crea, pero en la sede. Se avisa
     fuerte porque el síntoma es engañoso: la visita aparece agendada y quien
     atiende sale a la oficina cuando la persona lo espera en la casa. */
  if (lugar_cita === 'item' && !ubicacionItem) {
    await log(
      `⚠️ la cita es EN el ítem pero "${servicio || 'el ítem'}" no tiene dirección ` +
        `cargada en el catálogo; queda con la ubicación de la sede`,
    );
  }

  const payload = {
    assigned_user_id: usuario.id_sub_usuario,
    id_profesional: idProfesional || null,
    booked_tz: 'America/Guayaquil',
    calendar_id: calendarId,
    create_meet: true,
    created_by_user_id: usuario.id_usuario,
    description: descripcion || '',
    end: fin_utc,
    invitees: [{ name: nombre, email: correo, phone: telefono }],
    buffer_minutos: bufferSede,
    // Para un servicio presencial la ubicación es la sede, no "online".
    location_text:
      ubicacionItem ||
      (establecimiento
        ? [establecimiento.nombre, establecimiento.direccion, establecimiento.ciudad]
            .filter(Boolean)
            .join(' — ')
            .slice(0, 255)
        : 'online'),
    meeting_url: null,
    start: inicio_utc,
    status: 'Agendado',
    title: `${nombre} - ${servicio}`,
  };

  const cita = await servicioAppointments.createAppointment(
    payload,
    usuario.id_usuario,
  );

  // La sede se guarda aparte: createAppointment no la conoce y no vale la pena
  // meterle un campo que solo usa este flujo.
  if (establecimiento?.id && cita?.id) {
    await db.query(`UPDATE appointments SET id_establecimiento = ? WHERE id = ?`, {
      replacements: [establecimiento.id, cita.id],
      type: db.QueryTypes.UPDATE,
    });
  }

  await log(
    `✅ Cita creada: ${nombre} - ${servicio} - ${inicio_utc}` +
      `${establecimiento ? ` · agenda de "${establecimiento.nombre}"` : ''}` +
      `${ubicacionItem ? ` · en sitio: ${ubicacionItem}` : ''}` +
      `${bufferSede ? ` · ${bufferSede} min de traslado` : ''}`,
  );

  /* El pin. Cuando la cita es en un lugar que no es el local, saber la
     dirección no alcanza: hay que llegar. Va como ubicación de WhatsApp —el
     mapita que se toca y abre la navegación— y no como enlace, que en el
     celular obliga a salir de la app.

     Best-effort a propósito: la cita ya está creada y un pin que Meta rechace
     no puede convertirse en un error de agendamiento. */
  if (ubicacionItem && Number.isFinite(Number(item?.latitud)) && telefono) {
    try {
      const creds = await credencialesWhatsapp(id_configuracion);
      if (creds) {
        const envio = await enviarUbicacionWhatsapp({
          latitud: item.latitud,
          longitud: item.longitud,
          nombre: item.nombre,
          direccion: [item.direccion, item.sector || item.ciudad]
            .filter(Boolean)
            .join(', '),
          phone_whatsapp_to: telefono,
          id_configuracion,
          responsable: 'Agenda',
          ...creds,
        });
        if (!envio.ok) await log(`⚠️ no se pudo mandar el pin: ${envio.error}`);
      }
    } catch (e) {
      await log(`⚠️ no se pudo mandar el pin: ${e.message}`);
    }
  }

  return {
    ok: true,
    id: cita?.id || null,
    ubicacion: payload.location_text,
    id_profesional: idProfesional || null,
  };
}

module.exports = {
  crearCitaAgendada,
  elegirProfesionalLibre,
  resolverCalendario,
  credencialesWhatsapp,
};
