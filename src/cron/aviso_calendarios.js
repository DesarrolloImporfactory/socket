const cron = require('node-cron');
const { db } = require('../database/config');
const { sendWhatsappMessageTemplate } = require('../services/whatsapp.service'); // Si es necesario

const moment = require('moment-timezone');

async function withLock(lockName, fn) {
  const conn = await db.connectionManager.getConnection({ type: 'read' });
  try {
    const [row] = await db.query(`SELECT GET_LOCK(?, 1) AS got`, {
      replacements: [lockName],
      type: db.QueryTypes.SELECT,
    });
    if (!row || Number(row.got) !== 1) {
      console.log('🔒 No se obtuvo lock, otro proceso está ejecutando el cron');
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

cron.schedule('*/30 * * * *', async () => {
  await withLock('aviso_calendarios_cron_lock', async () => {
    console.log('⏱️ Ejecutando tarea de aviso de reuniones');

    // Obtener la fecha y hora actual en la zona horaria de Ecuador (Guayaquil)
    const ahora = moment().tz('America/Guayaquil'); // Hora actual en Ecuador
    const unaHoraAntes = moment().tz('America/Guayaquil').add(1, 'hour'); // 1 hora hacia adelante

    // Formateamos las fechas en el formato que espera SQL (YYYY-MM-DD HH:MM:SS)
    const ahoraFormateado = ahora.format('YYYY-MM-DD HH:mm:ss');
    const unaHoraAntesFormateado = unaHoraAntes.format('YYYY-MM-DD HH:mm:ss');

    console.log('Ahora en Ecuador: ' + ahoraFormateado);
    console.log('Una hora después en Ecuador: ' + unaHoraAntesFormateado);

    // Consultar las reuniones que están a menos de una hora de iniciar
    const reunionesPendientes = await db.query(
      `SELECT cal.account_id AS id_configuracion, ap.calendar_id, ap.title, ap.description, ap.meeting_url, ap.start_utc, apin.name AS nombre, apin.phone AS telefono FROM appointments ap INNER JOIN calendars cal ON cal.id = ap.calendar_id INNER JOIN appointment_invitees apin ON ap.id = apin.appointment_id
   WHERE start_utc BETWEEN ? AND ? AND (status = 'Agendado' OR status = 'Confirmado')`,
      {
        replacements: [ahoraFormateado, unaHoraAntesFormateado],
        type: db.QueryTypes.SELECT,
      }
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

        /* tomar la fecha y hora de la reunion y sacar solo la hora */
        let start_utc = reunion.start_utc;
        let date = new Date(start_utc); // convierte la cadena a un objeto Date
        let hours = date.getHours(); // obtiene solo la hora
        let minutes = date.getMinutes(); // obtener los minutos
        // Asegura que los minutos siempre tengan dos dígitos
        let formattedMinutes = minutes < 10 ? '0' + minutes : minutes;

        let hora_completa = hours + ':' + formattedMinutes;
        /* tomar la fecha y hora de la reunion y sacar solo la hora */

        const configuraciones = await db.query(
          `SELECT token, id_whatsapp, id_telefono, template_notificar_calendario, telefono FROM configuraciones WHERE id = ? AND supendido = 0`,
          {
            replacements: [id_configuracion],
            type: db.QueryTypes.SELECT,
          }
        );

        if (configuraciones && configuraciones.length > 0) {
          // Si hay resultados, asignamos los valores a las variables
          let accessToken = configuraciones[0].token;
          let business_phone_id = configuraciones[0].id_telefono;
          let id_whatsapp = configuraciones[0].id_whatsapp;
          let nombre_template =
            configuraciones[0].template_notificar_calendario;
          let telefono_configuracion = configuraciones[0].telefono;

          // Preparar los parámetros para el template (puedes agregar más parámetros si es necesario)
          const template_parameters = [
            nombre,
            title,
            hora_completa,
            meeting_url,
          ];

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
        } else {
          console.log('No se encontraron configuraciones.');
        }
      } catch (err) {
        console.error('❌ Error enviando aviso de reunión:', err.message);
      }
    }
  });
});
