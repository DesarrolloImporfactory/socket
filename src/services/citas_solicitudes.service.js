'use strict';

/* Solicitudes de cita: la bandeja de lo que el bot levantó y todavía no existe
   en el calendario.

   El bot puede agendar solo, y para muchos negocios eso es lo que se quiere.
   Pero hay agendas donde no: quien atiende puede estar durmiendo, en una
   reunión o manejando, y enterarse de una visita cuando faltan veinte minutos.
   Con `modo: 'solicitud'` en la acción `agendar_cita`, el bot hace todo su
   trabajo —levanta el interés, el contacto, qué quiere ver y cuándo le viene
   bien— y deja el pedido acá.

   Confirmar es un clic y pasa por el MISMO camino que usa el bot
   (citas_agenda.service), así que la agenda, quien atiende, el traslado y la
   dirección se deciden igual en los dos casos. */

const moment = require('moment-timezone');

const { db } = require('../database/config');
const {
  crearCitaAgendada,
  credencialesWhatsapp,
} = require('./citas_agenda.service');
const {
  enviarMensajeWhatsapp,
} = require('../utils/webhook_whatsapp/enviarMensajes');

const TZ = 'America/Guayaquil';

/* Días y meses a mano: `moment` viene solo con el locale inglés y cargar el
   español globalmente le cambiaría el formato a todo lo demás que usa moment en
   el sistema. Es un arreglo de doce strings contra un efecto secundario que
   aparecería en otra pantalla. */
const DIAS = [
  'domingo',
  'lunes',
  'martes',
  'miércoles',
  'jueves',
  'viernes',
  'sábado',
];

const MESES = [
  'enero',
  'febrero',
  'marzo',
  'abril',
  'mayo',
  'junio',
  'julio',
  'agosto',
  'septiembre',
  'octubre',
  'noviembre',
  'diciembre',
];

/* El aviso al cliente. La persona quedó esperando ("te confirmo el horario"),
   así que confirmar sin avisarle deja el trabajo a medias: la cita existe en el
   calendario y ella no sabe nada.

   Sale como texto libre, que solo entra si la ventana de 24 horas de Meta sigue
   abierta. Casi siempre lo está —acaba de escribir— pero si se confirma dos
   días después no entra, y por eso la respuesta dice si se pudo o no: quien
   confirma tiene que saber que le toca escribirle a mano. */
async function avisarClienteCita({ id_configuracion, telefono, texto }) {
  if (!telefono) return { ok: false, error: 'sin teléfono' };
  try {
    const creds = await credencialesWhatsapp(id_configuracion);
    if (!creds) return { ok: false, error: 'la cuenta no tiene WhatsApp conectado' };

    await enviarMensajeWhatsapp({
      phone_whatsapp_to: telefono,
      texto_mensaje: texto,
      id_configuracion,
      responsable: 'Agenda',
      ...creds,
    });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/**
 * Lo pendiente, con todo lo que hace falta para decidir sin abrir el chat:
 * quién es, qué quiere ver, dónde queda y cuándo le viene bien.
 */
async function listarSolicitudes({ id_configuracion, estado = 'pendiente', limite = 100 }) {
  const estados = ['pendiente', 'agendada', 'descartada'];
  const filtro = estados.includes(estado) ? estado : 'pendiente';

  const filas = await db.query(
    `SELECT s.id, s.estado, s.nombre, s.telefono, s.correo, s.servicio,
            s.preferencia_texto, s.inicio_sugerido, s.duracion_minutos,
            s.notas, s.created_at, s.id_cita, s.id_cliente,
            s.id_producto, s.id_establecimiento,
            p.nombre        AS producto_nombre,
            p.direccion     AS producto_direccion,
            p.sector        AS producto_sector,
            p.ciudad        AS producto_ciudad,
            p.imagen_url    AS producto_imagen,
            p.duracion      AS producto_duracion,
            e.nombre        AS sede_nombre,
            e.buffer_minutos AS sede_buffer,
            c.nombre_cliente, c.apellido_cliente, c.celular_cliente,
            c.estado_contacto
       FROM citas_solicitudes s
       LEFT JOIN productos_chat_center     p ON p.id = s.id_producto
       LEFT JOIN establecimientos_chat_center e ON e.id = s.id_establecimiento
       LEFT JOIN clientes_chat_center      c ON c.id = s.id_cliente
      WHERE s.id_configuracion = ? AND s.estado = ?
      ORDER BY s.created_at DESC
      LIMIT ?`,
    {
      replacements: [id_configuracion, filtro, Number(limite) || 100],
      type: db.QueryTypes.SELECT,
    },
  );

  /* La hora se guarda en UTC y se devuelve además en hora local, ya formateada:
     el formulario de confirmación la precarga tal cual y no hay dos lugares
     convirtiendo zonas horarias con criterios distintos. */
  return filas.map((f) => ({
    ...f,
    inicio_sugerido_local: f.inicio_sugerido
      ? moment.utc(f.inicio_sugerido).tz(TZ).format('YYYY-MM-DDTHH:mm')
      : null,
  }));
}

async function contarPendientes(id_configuracion) {
  const [row] = await db.query(
    `SELECT COUNT(*) AS n FROM citas_solicitudes
      WHERE id_configuracion = ? AND estado = 'pendiente'`,
    { replacements: [id_configuracion], type: db.QueryTypes.SELECT },
  );
  return Number(row?.n || 0);
}

/**
 * Confirma una solicitud: recién acá nace la cita.
 *
 * @param {object} p
 * @param {string} p.inicio  'YYYY-MM-DDTHH:mm' en hora local del negocio. Puede
 *   venir distinto de lo que sugirió el bot — es el punto de todo esto: quien
 *   confirma es quien decide la hora.
 */
async function confirmarSolicitud({
  id,
  id_configuracion,
  inicio,
  duracion_minutos,
  id_usuario = null,
  nombre,
  telefono,
  notas,
}) {
  const [sol] = await db.query(
    `SELECT * FROM citas_solicitudes WHERE id = ? AND id_configuracion = ? LIMIT 1`,
    { replacements: [id, id_configuracion], type: db.QueryTypes.SELECT },
  );

  if (!sol) return { ok: false, motivo: 'La solicitud no existe' };
  if (sol.estado === 'agendada') {
    return { ok: false, motivo: 'Esa solicitud ya tiene una cita creada' };
  }

  const mIni = inicio
    ? moment.tz(inicio, 'YYYY-MM-DDTHH:mm', TZ)
    : sol.inicio_sugerido
      ? moment.utc(sol.inicio_sugerido).tz(TZ)
      : null;

  if (!mIni || !mIni.isValid()) {
    return { ok: false, motivo: 'Falta la fecha y hora de la cita' };
  }

  /* Cuánto dura. Lo que mande quien confirma manda; si no manda nada, lo que
     dijo el bot; y si tampoco, la duración del ítem en el catálogo. 60 minutos
     es el último recurso, no el default silencioso. */
  const minutos =
    Number(duracion_minutos) > 0
      ? Number(duracion_minutos)
      : Number(sol.duracion_minutos) > 0
        ? Number(sol.duracion_minutos)
        : null;

  let duracionFinal = minutos;
  let item = null;

  if (sol.id_producto) {
    const [p] = await db.query(
      `SELECT id, nombre, direccion, sector, ciudad, latitud, longitud,
              duracion, id_establecimiento
         FROM productos_chat_center WHERE id = ? LIMIT 1`,
      { replacements: [sol.id_producto], type: db.QueryTypes.SELECT },
    );
    item = p || null;
    if (!duracionFinal && Number(p?.duracion) > 0) duracionFinal = Number(p.duracion);
  }
  if (!duracionFinal) duracionFinal = 60;

  /* La sede: la que quedó guardada, la del ítem, o la única que haya. Sin esto
     la cita cae en el primer calendario de la cuenta y una inmobiliaria con dos
     oficinas manda al corredor equivocado. */
  const idSede = sol.id_establecimiento || item?.id_establecimiento || null;
  const sedes = await db.query(
    `SELECT id, nombre, ciudad, direccion, id_calendario, buffer_minutos
       FROM establecimientos_chat_center
      WHERE id_configuracion = ? AND eliminado = 0 AND activo = 1
      ORDER BY orden ASC, id ASC`,
    { replacements: [id_configuracion], type: db.QueryTypes.SELECT },
  );

  const establecimiento =
    (idSede && sedes.find((s) => Number(s.id) === Number(idSede))) ||
    (sedes.length === 1 ? sedes[0] : null);

  /* La hora local, guardada ANTES de convertir.
     `moment.utc()` no devuelve una copia: muta el objeto. Como el `inicio_utc`
     de abajo la llama sobre `mIni`, todo lo que use `mIni` después queda en UTC
     — y el mensaje que le llega al cliente se armaba con esa hora. La cita
     quedaba bien a las 15:00 y a la persona le decíamos "a las 20:00". */
  const mLocal = mIni.clone();

  const resultado = await crearCitaAgendada({
    id_configuracion,
    establecimiento,
    item,
    // Si el ítem tiene dirección propia, la visita es ahí: es la misma regla
    // que aplica el bot, y acá no hay una columna de la que leer la config.
    lugar_cita: String(item?.direccion || '').trim() ? 'item' : 'sede',
    nombre: (nombre ?? sol.nombre) || '',
    telefono: (telefono ?? sol.telefono) || '',
    correo: sol.correo || '',
    servicio: sol.servicio || item?.nombre || 'Cita',
    inicio_utc: mIni.utc().format(),
    fin_utc: mIni.clone().add(duracionFinal, 'minutes').utc().format(),
    descripcion: notas || sol.notas || '',
  });

  if (!resultado.ok) return resultado;

  await db.query(
    `UPDATE citas_solicitudes
        SET estado = 'agendada', id_cita = ?, atendida_por = ?,
            inicio_sugerido = ?, duracion_minutos = ?,
            notas = COALESCE(?, notas), updated_at = NOW()
      WHERE id = ?`,
    {
      replacements: [
        resultado.id,
        id_usuario,
        mIni.utc().format('YYYY-MM-DD HH:mm:ss'),
        duracionFinal,
        notas || null,
        id,
      ],
      type: db.QueryTypes.UPDATE,
    },
  );

  const telefonoFinal = (telefono ?? sol.telefono) || '';
  const queVe = sol.servicio || item?.nombre || '';

  const aviso = await avisarClienteCita({
    id_configuracion,
    telefono: telefonoFinal,
    texto:
      `¡Listo! Confirmada tu ${queVe ? `visita a ${queVe}` : 'cita'} para el ` +
      `${DIAS[mLocal.day()]} ${mLocal.date()} de ${MESES[mLocal.month()]} a las ${mLocal.format('HH:mm')}.` +
      (resultado.ubicacion && resultado.ubicacion !== 'online'
        ? `\n\n📍 ${resultado.ubicacion}`
        : ''),
  });

  return {
    ok: true,
    id_cita: resultado.id,
    ubicacion: resultado.ubicacion,
    repetida: Boolean(resultado.repetida),
    inicio_local: mLocal.format('YYYY-MM-DD HH:mm'),
    telefono: telefonoFinal,
    nombre: (nombre ?? sol.nombre) || '',
    // Que quien confirma sepa si al cliente le llegó o le toca escribirle.
    aviso_enviado: aviso.ok,
    aviso_error: aviso.ok ? null : aviso.error,
  };
}

/**
 * Descarta. El contacto NO se mueve de columna: puede haber sido descartado
 * porque el horario no daba, no porque la persona no sirva, y decidir eso es de
 * quien lleva el tablero.
 */
async function descartarSolicitud({ id, id_configuracion, id_usuario = null, motivo }) {
  const [afectadas] = await db.query(
    `UPDATE citas_solicitudes
        SET estado = 'descartada', atendida_por = ?,
            notas = TRIM(CONCAT(COALESCE(notas, ''), ?)), updated_at = NOW()
      WHERE id = ? AND id_configuracion = ? AND estado = 'pendiente'`,
    {
      replacements: [
        id_usuario,
        motivo ? `\nDescartada: ${String(motivo).slice(0, 300)}` : '',
        id,
        id_configuracion,
      ],
      type: db.QueryTypes.UPDATE,
    },
  );

  return { ok: true, afectadas };
}

module.exports = {
  listarSolicitudes,
  contarPendientes,
  confirmarSolicitud,
  descartarSolicitud,
};
