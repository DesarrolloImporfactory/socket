const cron = require('node-cron');
const { db } = require('../database/config');
const { sendWhatsappMessageTemplate } = require('../services/whatsapp.service'); // Si es necesario

const moment = require('moment-timezone');
const {
  construirParametrosRecordatorio,
} = require('../utils/variablesRecordatorio');

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

      /* Cada cuenta decide cuántos avisos manda y con cuánta anticipación
         (configuraciones.recordatorios_cita, ej "24,2"). Sin configurar sigue
         siendo uno a la hora, que es como funcionaba antes.

         Se busca por cada anticipación una ventana de VENTANA_MIN minutos: el
         cron corre cada minuto, así que basta un margen chico para no perder
         citas si una corrida se atrasa. Que no se repita lo garantiza la tabla
         appointment_avisos_enviados, no la ventana. */
      const VENTANA_MIN = 6;

      const cuentas = await db.query(
        `SELECT id, recordatorios_cita FROM configuraciones WHERE suspendido = 0`,
        { type: db.QueryTypes.SELECT },
      );

      const horasPorCuenta = new Map();
      const todasLasHoras = new Set();
      for (const c of cuentas) {
        const horas = String(c.recordatorios_cita || '1')
          .split(',')
          .map((h) => Number(String(h).trim()))
          .filter((h) => Number.isFinite(h) && h > 0 && h <= 168);
        const finales = horas.length ? [...new Set(horas)] : [1];
        horasPorCuenta.set(Number(c.id), finales);
        finales.forEach((h) => todasLasHoras.add(h));
      }


      // Citas que entran en alguna de las ventanas configuradas
      const reunionesPendientes = [];
      for (const horas of todasLasHoras) {
        const desde = moment
          .utc()
          .add(horas, 'hours')
          .subtract(VENTANA_MIN, 'minutes')
          .format('YYYY-MM-DD HH:mm:ss');
        const hasta = moment
          .utc()
          .add(horas, 'hours')
          .format('YYYY-MM-DD HH:mm:ss');

        const filas = await db.query(
          `SELECT cal.account_id AS id_configuracion, cal.time_zone,
          ap.id AS appointment_id,
          ap.calendar_id, ap.title, ap.description, ap.meeting_url,
          ap.start_utc,
          est.nombre AS sede_nombre, est.direccion AS sede_direccion,
          est.ciudad AS sede_ciudad, est.provincia AS sede_provincia,
          est.google_maps_url AS sede_maps,
          est.telefono AS sede_telefono,
          apin.id AS invitee_id,
          apin.name AS nombre,
          apin.phone AS telefono
   FROM appointments ap
   INNER JOIN calendars cal ON cal.id = ap.calendar_id
   INNER JOIN appointment_invitees apin ON ap.id = apin.appointment_id
   LEFT JOIN establecimientos_chat_center est ON est.id = ap.id_establecimiento
   WHERE ap.start_utc BETWEEN ? AND ?
     AND (ap.status = 'Agendado' OR ap.status = 'Confirmado')
     AND NOT EXISTS (
           SELECT 1 FROM appointment_avisos_enviados ae
            WHERE ae.invitee_id = apin.id AND ae.horas_antes = ?
         )`,
          {
            replacements: [desde, hasta, horas],
            type: db.QueryTypes.SELECT,
          },
        );

        // Cada cuenta solo recibe los avisos que ella configuró
        for (const f of filas) {
          const suyas = horasPorCuenta.get(Number(f.id_configuracion)) || [1];
          if (suyas.includes(horas)) reunionesPendientes.push({ ...f, horas });
        }
      }

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

          const configuraciones = await db.query(
            `SELECT token, id_whatsapp, id_telefono, template_notificar_calendario,
                    recordatorios_cita_plantillas, telefono, nombre_configuracion
               FROM configuraciones WHERE id = ? AND suspendido = 0`,
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
            let telefono_configuracion = configuraciones[0].telefono;

            /* Cada anticipación manda su propio mensaje: el de la víspera
               confirma que la cita sigue en pie y el de la última hora avisa
               que ya salga. Mandar el mismo texto en los dos se lee como spam.
               Si la cuenta no eligió uno para esta hora, cae al de siempre. */
            let plantillasPorHora = {};
            try {
              plantillasPorHora =
                JSON.parse(
                  configuraciones[0].recordatorios_cita_plantillas || '{}',
                ) || {};
            } catch {
              plantillasPorHora = {};
            }

            const avisoCrudo =
              plantillasPorHora[reunion.horas] ||
              plantillasPorHora[String(reunion.horas)] ||
              null;
            /* body: null = la cuenta nunca eligió mapeo (formato viejo) y va el
               de siempre. body: [] = eligió una plantilla SIN variables y hay
               que mandarla sin parámetros; confundir los dos casos haría que
               Meta rechace el envío. */
            const aviso =
              typeof avisoCrudo === 'string'
                ? { plantilla: avisoCrudo, body: null }
                : avisoCrudo;

            let nombre_template =
              aviso?.plantilla ||
              configuraciones[0].template_notificar_calendario;

            /* Sin plantilla configurada Meta rechaza el envío y el error se
               perdía en el catch. Mejor decirlo y no gastar el intento. */
            if (!nombre_template) {
              console.log(
                `⚠️ Config ${id_configuracion} sin plantilla para el aviso de ${reunion.horas}h: no se envía el recordatorio de "${title}"`,
              );
              continue;
            }

            /* Los parámetros salen del mapeo que eligió el cliente: su plantilla
               puede tener las variables que quiera —o ninguna— y cada una lleva
               el dato que él decidió. Sin mapeo guardado se usa el orden de
               siempre (nombre, servicio, hora, ubicación), que es lo que
               mandaban las cuentas de antes. */
            const mapeo = Array.isArray(aviso?.body)
              ? aviso.body
              : ['nombre', 'servicio', 'hora', 'ubicacion'];

            const template_parameters = construirParametrosRecordatorio(mapeo, {
              nombre,
              title,
              description,
              start_utc: reunion.start_utc,
              time_zone: reunion.time_zone,
              meeting_url,
              sede_nombre: reunion.sede_nombre,
              sede_direccion: reunion.sede_direccion,
              sede_ciudad: reunion.sede_ciudad,
              sede_provincia: reunion.sede_provincia,
              sede_maps: reunion.sede_maps,
              sede_telefono: reunion.sede_telefono,
              negocio: configuraciones[0].nombre_configuracion,
            });

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

            console.log(
              `📝 Aviso (${reunion.horas}h antes) enviado a reunión ${reunion.title}`,
            );

            /* Se registra ESTE aviso en concreto. El flag del invitado no
               alcanza cuando hay varios: diría "ya se avisó" después del
               primero y los demás no saldrían nunca. Igual se mantiene
               actualizado por si algo más lo lee. */
            await db.query(
              `INSERT IGNORE INTO appointment_avisos_enviados
                 (appointment_id, invitee_id, horas_antes)
               VALUES (?, ?, ?)`,
              {
                replacements: [
                  reunion.appointment_id,
                  reunion.invitee_id,
                  reunion.horas,
                ],
                type: db.QueryTypes.INSERT,
              },
            );

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
