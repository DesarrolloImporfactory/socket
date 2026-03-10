const cron = require('node-cron');
const { db } = require('../database/config');
const {
  sendWhatsappMessageTemplateScheduled,
  prefetchTemplates,
  pruneTemplateCache,
} = require('../services/whatsapp.service');

async function withLock(lockName, fn) {
  const conn = await db.connectionManager.getConnection({ type: 'read' });
  try {
    const [row] = await db.query(`SELECT GET_LOCK(?, 1) AS got`, {
      replacements: [lockName],
      type: db.QueryTypes.SELECT,
    });

    if (!row || Number(row.got) !== 1) {
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
  } finally {
    db.connectionManager.releaseConnection(conn);
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

      // 1) Buscar pendientes listos para enviar
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

      // ══════════════════════════════════════════════════════
      // 1.5) PRE-FETCH de plantillas ANTES del loop de envío
      // ══════════════════════════════════════════════════════
      try {
        const prefetched = await prefetchTemplates(pendientes);
        if (prefetched > 0) {
          console.log(
            `💾 [CRON templateProgramadoMasivo] Pre-cacheadas ${prefetched} plantilla(s) desde Meta`,
          );
        }
      } catch (prefetchErr) {
        console.warn(
          '⚠️ [CRON templateProgramadoMasivo] Error en prefetch (no fatal):',
          prefetchErr.message,
        );
      }

      // 2) Enviar mensajes con retraso entre cada uno
      for (const [index, item] of pendientes.entries()) {
        const itemStart = Date.now();

        try {
          // Retraso siempre 5s entre un item y el anterio
          if (index > 0) {
            await new Promise((resolve) => setTimeout(resolve, 5000));
          }

          // Toma atómica del registro
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
            continue;
          }

          // Parseo de JSONs
          const template_parameters = parseJsonSafe(
            item.template_parameters_json,
            [],
          );
          const header_parameters = parseJsonSafe(
            item.header_parameters_json,
            null,
          );

          // Envío (con timeout)
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

          // ── FIX 1 ────────────────────────────────────────────────────────
          // AND estado = 'procesando' evita que un background tardío
          // (request HTTP que siguió corriendo tras el timeout) sobreescriba
          // un estado que ya fue resuelto por otro tick como 'error'.
          // Sin esta condición: el background llega ~50s después, encuentra
          // id=X en estado='error' y lo pisa con 'enviado', generando el
          // registro inconsistente que veías (estado=error + id_wamid lleno).
          // ─────────────────────────────────────────────────────────────────
          await db.query(
            `
            UPDATE template_envios_programados
            SET estado = 'enviado',
                enviado_en = NOW(),
                id_wamid_mensaje = ?,
                error_message = NULL,
                actualizado_en = NOW()
            WHERE id = ?
              AND estado = 'procesando'
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

          // ── FIX 2 ────────────────────────────────────────────────────────
          // Si el error es TIMEOUT, el request HTTP ya salió hacia Meta y
          // puede haber sido procesado. Si devolvemos a 'pendiente', el
          // siguiente tick lo reenvía aunque el mensaje ya llegó → duplicado.
          // Por eso en timeout siempre marcamos 'error' (no reintentar).
          // El operador puede revisar en Meta si llegó y corregir manualmente.
          // ─────────────────────────────────────────────────────────────────
          const esCancelablePorTimeout = err?.code === 'TIMEOUT';
          const nuevoEstado =
            esCancelablePorTimeout || intentosActuales >= maxIntentos
              ? 'error'
              : 'pendiente';

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
                AND estado = 'procesando'
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

          if (err?.meta_status || err?.meta_error) {
            console.error('🧾 [Meta error detail]', {
              id: item.id,
              meta_status: err.meta_status || null,
              meta_error: err.meta_error || null,
            });
          }
        }
      }

      // 3) Limpiar cache expirado al final del ciclo
      pruneTemplateCache();
    } catch (error) {
      console.error(
        '❌ [CRON templateProgramadoMasivo] Error general:',
        error.message,
      );
    } finally {
      const ms = Date.now() - cicloInicio;
      if (ms > 1000) {
        console.log(
          `🏁 [CRON templateProgramadoMasivo] Ciclo finalizado en ${ms}ms`,
        );
      }
    }
  });
});
