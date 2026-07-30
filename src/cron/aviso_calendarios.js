const cron = require('node-cron');
const { db } = require('../database/config');
const { sendWhatsappMessageTemplate } = require('../services/whatsapp.service'); // Si es necesario

const moment = require('moment-timezone');
const { enlaceUbicacionSede } = require('../utils/ubicacionSede');

async function withLock(lockName, fn) {
  const conn = await db.connectionManager.getConnection({ type: 'read' });
  try {
    const [row] = await db.query(`SELECT GET_LOCK(?, 1) AS got`, {
      replacements: [lockName],
      type: db.QueryTypes.SELECT,
    });
    if (!row || Number(row.got) !== 1) {
      /* console.log('🔒 No se obtuvo lock, otro proceso está ejecutando el cron'); */
      return;
    }
    try {
      await fn();
    } finally {
      await db.query(`DO RELEASE_LOCK(?)`, {
        replacements: [lockName],
        type: db.QueryTypes.RAW,
      });
    }
  } finally {
    db.connectionManager.releaseConnection(conn);
  }
}

let isRunning = false;

cron.schedule('*/1 * * * *', async () => {
  if (isRunning) return;
  isRunning = true;
  try {
    await withLock('aviso_calendarios_cron_lock', async () => {
      console.log('⏱️ Ejecutando tarea de aviso de reuniones');

      /* La ventana va en UTC porque start_utc está en UTC. Antes se calculaba
         en hora de Ecuador y se comparaba contra UTC: el recordatorio de "una
         hora antes" salía cuando la cita ya había pasado hace cuatro. */
      const ahoraFormateado = moment.utc().format('YYYY-MM-DD HH:mm:ss');
      const unaHoraAntesFormateado = moment
        .utc()
        .add(1, 'hour')
        .format('YYYY-MM-DD HH:mm:ss');

      // Consultar las reuniones que están a menos de una hora de iniciar
      const reunionesPendientes = await db.query(
        `SELECT cal.account_id AS id_configuracion, cal.time_zone,
          ap.calendar_id, ap.title, ap.description, ap.meeting_url,
          ap.start_utc,
          est.nombre AS sede_nombre, est.direccion AS sede_direccion,
          est.ciudad AS sede_ciudad, est.provincia AS sede_provincia,
          est.google_maps_url AS sede_maps,
          apin.id AS invitee_id,
          apin.name AS nombre,
          apin.phone AS telefono
   FROM appointments ap
   INNER JOIN calendars cal ON cal.id = ap.calendar_id
   INNER JOIN appointment_invitees apin ON ap.id = apin.appointment_id
   LEFT JOIN establecimientos_chat_center est ON est.id = ap.id_establecimiento
   WHERE start_utc BETWEEN ? AND ?
     AND (status = 'Agendado' OR status = 'Confirmado')
     AND apin.aviso_enviado = 0`,
        {
          replacements: [ahoraFormateado, unaHoraAntesFormateado],
          type: db.QueryTypes.SELECT,
        },
      );

      // Enviar notificaciones a los usuarios de las reuniones
      for (const reunion of reunionesPendientes) {
        try {
          const mensaje = `🚨 Recordatorio: Tu reunión con ID está por comenzar en menos de una hora. ¡No olvides asistir!`;

          let id_configuracion = reunion.id_configuracion;
          let calendar_id = reunion.calendar_id;
          let title = reunion.title;
          let description = reunion.description;
          let meeting_url = reunion.meeting_url;
          let nombre = reunion.nombre;
          let telefono = reunion.telefono;

          /* La hora que ve el cliente, en la zona del calendario. start_utc
             llega como texto UTC: pasarlo por new Date() lo tomaba como hora
             local y el recordatorio anunciaba la cita 5 horas más tarde de lo
             que era. */
          const hora_completa = moment
            .utc(reunion.start_utc)
            .tz(reunion.time_zone || 'America/Guayaquil')
            .format('HH:mm');

          const configuraciones = await db.query(
            `SELECT token, id_whatsapp, id_telefono, template_notificar_calendario, telefono FROM configuraciones WHERE id = ? AND suspendido = 0`,
            {
              replacements: [id_configuracion],
              type: db.QueryTypes.SELECT,
            },
          );

          if (configuraciones && configuraciones.length > 0) {
            // Si hay resultados, asignamos los valores a las variables
            let accessToken = configuraciones[0].token;
            let business_phone_id = configuraciones[0].id_telefono;
            let id_whatsapp = configuraciones[0].id_whatsapp;
            let nombre_template =
              configuraciones[0].template_notificar_calendario;
            let telefono_configuracion = configuraciones[0].telefono;

            /* Sin plantilla configurada Meta rechaza el envío y el error se
               perdía en el catch. Mejor decirlo y no gastar el intento. */
            if (!nombre_template) {
              console.log(
                `⚠️ Config ${id_configuracion} sin template_notificar_calendario: no se envía el recordatorio de "${title}"`,
              );
              continue;
            }

            /* Dónde es la cita. En una cita presencial meeting_url va en NULL, y
               un parámetro vacío hace que Meta tumbe la plantilla entera (132000)
               sin que se note. El enlace de Maps de la sede ocupa ese lugar: es
               el dato que el cliente necesita justo antes de salir. */
            const donde =
              meeting_url ||
              enlaceUbicacionSede({
                google_maps_url: reunion.sede_maps,
                direccion: reunion.sede_direccion,
                ciudad: reunion.sede_ciudad,
                provincia: reunion.sede_provincia,
              }) ||
              reunion.sede_nombre ||
              'Te esperamos en el local';

            const template_parameters = [nombre, title, hora_completa, donde];

            // Aquí puedes enviar el mensaje por WhatsApp usando la plantilla
            await sendWhatsappMessageTemplate({
              telefono: reunion.telefono, // Asegúrate de tener el teléfono del usuario
              telefono_configuracion,
              business_phone_id: business_phone_id, // ID de teléfono de la empresa
              waba_id: id_whatsapp,
              accessToken: accessToken, // Token de acceso
              id_configuracion: reunion.id_configuracion, // ID de configuración
              responsable: 'Aviso calendario', // Responsable que envía el mensaje
              nombre_template: nombre_template, // Nombre del template de Meta
              template_parameters: template_parameters, // Parámetros a reemplazar en la plantilla
            });

            console.log(`📝 Aviso enviado a reunión ${reunion.title}`);

            // 👇 MARCAR INVITADO COMO AVISADO
            await db.query(
              `UPDATE appointment_invitees 
   SET aviso_enviado = 1, aviso_enviado_at = NOW() 
   WHERE id = ?`,
              {
                replacements: [reunion.invitee_id],
                type: db.QueryTypes.UPDATE,
              },
            );
          } else {
            console.log('No se encontraron configuraciones.');
          }
        } catch (err) {
          console.error('❌ Error enviando aviso de reunión:', err.message);

          // 👇 AGREGA ESTAS LÍNEAS
          if (err.response) {
            console.error('📋 Status:', err.response.status);
            console.error(
              '📋 Data de Meta:',
              JSON.stringify(err.response.data, null, 2),
            );
          }
          console.error('📋 Reunión que falló:', {
            title: reunion.title,
            telefono: reunion.telefono,
            nombre: reunion.nombre,
            id_configuracion: reunion.id_configuracion,
          });
        }
      }
    });
  } finally {
    isRunning = false;
  }
});
