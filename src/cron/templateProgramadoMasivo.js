const cron = require('node-cron');
const { db } = require('../database/config');
const {
  sendWhatsappMessageTemplateScheduled,
} = require('../services/whatsapp.service');

async function withLock(lockName, fn) {
  const [row] = await db.query(`SELECT GET_LOCK(?, 1) AS got`, {
    replacements: [lockName],
    type: db.QueryTypes.SELECT,
  });

  if (!row || Number(row.got) !== 1) {
    // log silencioso o mínimo
    return;
  }

  try {
    await fn();
  } finally {
    try {
      await db.query(`DO RELEASE_LOCK(?)`, {
        replacements: [lockName],
        type: db.QueryTypes.RAW,
      });
    } catch (e) {
      console.error(
        '❌ [CRON templateProgramadoMasivo] Error liberando lock:',
        e.message,
      );
    }
  }
}

function parseJsonSafe(value, fallback) {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch (_) {
    return fallback;
  }
}

function withTimeout(promise, ms, label = 'Operación') {
  let timer = null;

  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(`${label} excedió ${ms}ms`);
      err.code = 'TIMEOUT';
      reject(err);
    }, ms);
  });

  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/**
 * Ejecuta UPDATE y luego obtiene ROW_COUNT() real desde MySQL/MariaDB.
 * IMPORTANTE: depende de que ambas consultas salgan por la misma conexión.
 */
async function execUpdateAndRowCount(sql, replacements = []) {
  await db.query(sql, {
    replacements,
    type: db.QueryTypes.UPDATE,
  });

  const [rowCountRow] = await db.query(`SELECT ROW_COUNT() AS affectedRows`, {
    type: db.QueryTypes.SELECT,
  });

  return Number(rowCountRow?.affectedRows || 0);
}

/**
 * Cron: envíos programados de templates WhatsApp
 * Corre cada minuto
 */
cron.schedule('* * * * *', async () => {
  await withLock('template_programado_masivo_lock', async () => {
    const cicloInicio = Date.now();

    try {
      // 0) Recovery de registros atascados en "procesando"
      const rescuedRows = await execUpdateAndRowCount(
        `
        UPDATE template_envios_programados
        SET estado = 'pendiente',
            error_message = CONCAT(
              '[AUTO-RECOVERY] Reencolado por cron (procesando > 10 min) | ',
              COALESCE(error_message, '')
            ),
            actualizado_en = NOW()
        WHERE estado = 'procesando'
          AND actualizado_en < (NOW() - INTERVAL 10 MINUTE)
          AND intentos < max_intentos
        `,
        [],
      );

      if (rescuedRows > 0) {
        console.log(
          `♻️ [CRON templateProgramadoMasivo] Reencolados por recovery: ${rescuedRows}`,
        );
      }

      // 1) Buscar pendientes listos para enviar (comparando en UTC)
      const pendientes = await db.query(
        `
        SELECT *
        FROM template_envios_programados
        WHERE estado = 'pendiente'
          AND fecha_programada_utc <= UTC_TIMESTAMP()
          AND intentos < max_intentos
        ORDER BY fecha_programada_utc ASC, id ASC
        LIMIT 100
        `,
        { type: db.QueryTypes.SELECT },
      );

      if (!pendientes.length) {
        return;
      }

      console.log(
        `📋 [CRON templateProgramadoMasivo] Pendientes encontrados: ${pendientes.length}`,
      );

      // 2) Enviar los mensajes con retraso entre cada uno para evitar bloqueo por spam
      for (const [index, item] of pendientes.entries()) {
        const itemStart = Date.now();

        try {
          // **Retraso entre cada mensaje (5 segundos por cada mensaje)**
          const delay = index * 5000; // 5 segundos de retraso entre cada mensaje

          // Esperar el retraso antes de enviar el siguiente mensaje
          await new Promise((resolve) => setTimeout(resolve, delay));

          // 2) Toma atómica del registro
          const affectedRows = await execUpdateAndRowCount(
            `
            UPDATE template_envios_programados
            SET estado = 'procesando',
                intentos = intentos + 1,
                actualizado_en = NOW()
            WHERE id = ?
              AND estado = 'pendiente'
              AND intentos < max_intentos
            `,
            [item.id],
          );

          if (!affectedRows) {
            // Otro proceso lo tomó o cambió de estado entre SELECT y UPDATE
            continue;
          }

          // 3) Parseo de JSONs
          const template_parameters = parseJsonSafe(
            item.template_parameters_json,
            [],
          );
          const header_parameters = parseJsonSafe(
            item.header_parameters_json,
            null,
          );

          // 4) Envío (con timeout de seguridad)
          const resp = await withTimeout(
            sendWhatsappMessageTemplateScheduled({
              telefono: item.telefono,
              telefono_configuracion: item.telefono_configuracion,
              id_configuracion: item.id_configuracion,
              responsable: 'cron_template_programado',

              nombre_template: item.nombre_template,
              language_code: item.language_code || null,
              template_parameters: Array.isArray(template_parameters)
                ? template_parameters
                : [],

              header_format: item.header_format || null,
              header_parameters: Array.isArray(header_parameters)
                ? header_parameters
                : null,
              header_media_url: item.header_media_url || null,
              header_media_name: item.header_media_name || null,
            }),
            45000,
            `sendWhatsappMessageTemplateScheduled id=${item.id}`,
          );

          const wamid = resp?.wamid || null;

          // 5) Marcar éxito y registrar la fecha de envío correctamente después del retraso
          await db.query(
            `
            UPDATE template_envios_programados
            SET estado = 'enviado',
                enviado_en = NOW(), 
                id_wamid_mensaje = ?,
                error_message = NULL,
                actualizado_en = NOW()
            WHERE id = ?
            `,
            {
              replacements: [wamid, item.id],
              type: db.QueryTypes.UPDATE,
            },
          );

          console.log(
            `✅ [CRON templateProgramadoMasivo] Enviado id=${item.id} tel=${item.telefono} wamid=${wamid || 'N/A'} ms=${Date.now() - itemStart}`,
          );
        } catch (err) {
          const intentosPrevios = Number(item.intentos || 0);
          const intentosActuales = intentosPrevios + 1;
          const maxIntentos = Number(item.max_intentos || 3);

          const nuevoEstado =
            intentosActuales >= maxIntentos ? 'error' : 'pendiente';

          const errorPayload = {
            message: err?.message || 'Error desconocido',
            code: err?.code || null,
            meta_status: err?.meta_status || null,
            meta_error: err?.meta_error || null,
            at: new Date().toISOString(),
          };

          try {
            await db.query(
              `
              UPDATE template_envios_programados
              SET estado = ?,
                  error_message = ?,
                  actualizado_en = NOW()
              WHERE id = ?
              `,
              {
                replacements: [
                  nuevoEstado,
                  JSON.stringify(errorPayload).slice(0, 4000),
                  item.id,
                ],
                type: db.QueryTypes.UPDATE,
              },
            );
          } catch (updateErr) {
            console.error(
              `❌ [CRON templateProgramadoMasivo] Error actualizando catch id=${item.id}:`,
              updateErr.message,
            );
          }

          console.error(
            `❌ [CRON templateProgramadoMasivo] Falló id=${item.id} estado=${nuevoEstado} intento=${intentosActuales}/${maxIntentos}:`,
            err?.message || err,
          );

          // Solo detalle extra si viene de Meta
          if (err?.meta_status || err?.meta_error) {
            console.error('🧾 [Meta error detail]', {
              id: item.id,
              meta_status: err.meta_status || null,
              meta_error: err.meta_error || null,
            });
          }
        }
      }
    } catch (error) {
      console.error(
        '❌ [CRON templateProgramadoMasivo] Error general:',
        error.message,
      );
    } finally {
      const ms = Date.now() - cicloInicio;
      // Log final solo si hubo actividad notable (>1s), opcional pero útil
      if (ms > 1000) {
        console.log(
          `🏁 [CRON templateProgramadoMasivo] Ciclo finalizado en ${ms}ms`,
        );
      }
    }
  });
});
