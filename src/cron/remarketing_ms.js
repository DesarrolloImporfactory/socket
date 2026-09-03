// cron/remarketing_ms.js
// -----------------------------------------------------------------------------
// Cron de remarketing para MESSENGER (v1, solo método IA). Mismo patrón que el
// de Instagram: procesa SOLO las filas source='ms' de remarketing_pendientes,
// solo dentro de la ventana de 24h (Messenger no tiene templates de pago).
//
// Reutiliza la generación de texto IA de remarketing_ig.service (agnóstica al
// canal) y envía por fb.sendText.
// -----------------------------------------------------------------------------

const cron = require('node-cron');
const { db } = require('../database/config');
const fb = require('../utils/facebookGraph');
const Store = require('../services/messenger_store.service');
const {
  generarRemarketingIgIA,
  log,
} = require('../services/remarketing_ig.service');
const { botApagadoExplicito } = require('../utils/interruptorBot');
const { esConexionCerrada } = require('../utils/conexionCerrada');

const VENTANA_HORAS = 24;

async function withLock(lockName, fn) {
  const t = await db.transaction();
  try {
    const [row] = await db.query(`SELECT GET_LOCK(?, 1) AS got`, {
      replacements: [lockName],
      type: db.QueryTypes.SELECT,
      transaction: t,
    });
    if (!row || Number(row.got) !== 1) {
      await t.rollback();
      return;
    }
    try {
      await fn();
    } finally {
      try {
        await db.query(`DO RELEASE_LOCK(?)`, {
          replacements: [lockName],
          type: db.QueryTypes.RAW,
          transaction: t,
        });
      } catch (_) {}
      // La conexión que sostiene el lock queda ociosa todo el ciclo: si MySQL
      // la cerró mientras tanto (wait_timeout/KILL/reinicio), el commit revienta
      // con "connection is in closed state". El lock ya murió junto con la sesión,
      // así que no hay nada que salvar: se ignora y el ciclo termina limpio.
      try {
        await t.commit();
      } catch (_) {}
    }
  } catch (e) {
    try {
      await t.rollback();
    } catch (_) {}
    throw e;
  }
}

async function cancelar(id, motivo) {
  await db.query(
    `UPDATE remarketing_pendientes
        SET cancelado = 1, error_message = ?, ultimo_intento_at = NOW()
      WHERE id = ?`,
    { replacements: [String(motivo).slice(0, 500), id], type: db.QueryTypes.UPDATE },
  );
}

async function registrarError(record, err) {
  const intentos = Number(record.intentos || 0) + 1;
  const maxIntentos = Number(record.max_intentos || 3);
  if (intentos >= maxIntentos) {
    await db.query(
      `UPDATE remarketing_pendientes
          SET cancelado = 1, intentos = ?, error_message = ?, ultimo_intento_at = NOW()
        WHERE id = ?`,
      {
        replacements: [
          intentos,
          `Agotó ${maxIntentos} intentos. Último: ${err.message}`.slice(0, 500),
          record.id,
        ],
        type: db.QueryTypes.UPDATE,
      },
    );
  } else {
    await db.query(
      `UPDATE remarketing_pendientes
          SET intentos = ?, error_message = ?, ultimo_intento_at = NOW()
        WHERE id = ?`,
      {
        replacements: [intentos, err.message.slice(0, 500), record.id],
        type: db.QueryTypes.UPDATE,
      },
    );
  }
}

// Ventana 24h de MS: último mensaje ENTRANTE del cliente.
async function dentroVentana24hMS(id_cliente_contacto) {
  const [row] = await db.query(
    `SELECT MAX(created_at) AS last_in
       FROM mensajes_clientes
      WHERE celular_recibe = ?
        AND source = 'ms'
        AND direction = 'in'
        AND deleted_at IS NULL`,
    { replacements: [String(id_cliente_contacto)], type: db.QueryTypes.SELECT },
  );
  if (!row || !row.last_in) return false;
  const horas = (Date.now() - new Date(row.last_in).getTime()) / (1000 * 60 * 60);
  return horas < VENTANA_HORAS;
}

async function getOwnerId(id_configuracion) {
  const [row] = await db.query(
    `SELECT id FROM clientes_chat_center
      WHERE id_configuracion = ? AND propietario = 1 AND deleted_at IS NULL
      LIMIT 1`,
    { replacements: [id_configuracion], type: db.QueryTypes.SELECT },
  );
  return row?.id || null;
}

let isRunning = false;

cron.schedule('*/1 * * * *', async () => {
  if (isRunning) return;
  isRunning = true;
  try {
    await withLock('remarketing_ms_cron_lock', async () => {
      const pendientes = await db.query(
        `SELECT * FROM remarketing_pendientes
          WHERE source = 'ms'
            AND enviado = 0
            AND cancelado = 0
            AND tiempo_disparo <= NOW()
            AND tiempo_disparo > NOW() - INTERVAL 3 DAY
            AND intentos < max_intentos
          ORDER BY tiempo_disparo ASC
          LIMIT 50`,
        { type: db.QueryTypes.SELECT },
      );

      if (!pendientes.length) return;
      await log(`[ms] 📋 Pendientes MS: ${pendientes.length}`);

      for (const record of pendientes) {
        try {
          const [cliente] = await db.query(
            `SELECT id, estado_contacto, enviar_remarketing
               FROM clientes_chat_center WHERE id = ? LIMIT 1`,
            { replacements: [record.id_cliente_chat_center], type: db.QueryTypes.SELECT },
          );
          if (!cliente) {
            await cancelar(record.id, 'Cliente no encontrado');
            continue;
          }
          if (cliente.estado_contacto !== record.estado_contacto_origen) {
            await cancelar(record.id, 'Estado cambió');
            continue;
          }
          if (Number(cliente.enviar_remarketing) === 0) {
            await cancelar(record.id, 'Cliente con enviar_remarketing=0');
            continue;
          }

          // Bot apagado en Asistentes → no envía ni cancela ni suma intento
          // (mismo criterio del cron de WA): si lo reenciende dentro de la
          // ventana de 3 días, el seguimiento se reanuda solo.
          if (await botApagadoExplicito(record.id_configuracion)) {
            continue;
          }

          // Ventana 24h de MS — fuera de ventana no se puede enviar (sin templates)
          if (!(await dentroVentana24hMS(record.id_cliente_chat_center))) {
            await cancelar(record.id, 'Fuera de ventana 24h MS (no se puede enviar)');
            await log(`[ms] ⏭️ id=${record.id} fuera de 24h — cancelado`);
            continue;
          }

          const [cfg] = await db.query(
            `SELECT api_key_openai, openai_activo FROM configuraciones WHERE id = ? LIMIT 1`,
            { replacements: [record.id_configuracion], type: db.QueryTypes.SELECT },
          );
          if (!cfg?.api_key_openai) {
            await cancelar(record.id, 'Sin api_key_openai');
            continue;
          }
          if (Number(cfg.openai_activo) === 0) {
            await log(`[ms] ⏸ id=${record.id} openai_activo=0, se salta y espera`);
            continue;
          }

          const [pageRow] = await db.query(
            `SELECT page_access_token FROM messenger_pages
              WHERE page_id = ? AND status = 'active' LIMIT 1`,
            { replacements: [record.page_id], type: db.QueryTypes.SELECT },
          );
          const pageAccessToken = pageRow?.page_access_token || null;
          if (!pageAccessToken) {
            await registrarError(record, new Error('Sin page_access_token MS'));
            continue;
          }

          const ownerId = await getOwnerId(record.id_configuracion);
          if (!ownerId) {
            await registrarError(record, new Error('Sin cliente propietario'));
            continue;
          }

          // Claim atómico
          const [claim] = await db.query(
            `UPDATE remarketing_pendientes
                SET enviado = 1, ultimo_intento_at = NOW()
              WHERE id = ? AND enviado = 0 AND cancelado = 0`,
            { replacements: [record.id] },
          );
          if (Number(claim?.affectedRows || 0) !== 1) continue;

          let mensajeEnviado = false;
          try {
            const texto = await generarRemarketingIgIA({
              id_configuracion: record.id_configuracion,
              id_cliente: record.id_cliente_chat_center,
              estado: record.estado_contacto_origen,
              prompt_ia: record.prompt_ia,
              api_key_openai: cfg.api_key_openai,
            });

            if (!texto || texto.trim().length < 3) {
              throw new Error('IA devolvió texto vacío');
            }

            const fbRes = await fb.sendText(
              record.external_id,
              texto,
              pageAccessToken,
            );
            mensajeEnviado = true;
            const mid = fbRes?.message_id || fbRes?.messages?.[0]?.id || null;

            await Store.saveOutgoingMessageUnified({
              id_configuracion: record.id_configuracion,
              id_plataforma: null,
              id_cliente: ownerId,
              celular_recibe: record.id_cliente_chat_center,
              source: 'ms',
              page_id: record.page_id,
              external_id: record.external_id,
              mid,
              text: texto,
              attachments: null,
              status_unificado: 'sent',
              responsable: 'cron_remarketing_ms',
              meta: { remarketing_ms: true, secuencia: record.secuencia },
            });

            await log(
              `[ms] 🤖 id=${record.id} remarketing MS enviado (${texto.length} chars) mid=${mid}`,
            );
          } catch (sendErr) {
            if (!mensajeEnviado) {
              await db.query(
                `UPDATE remarketing_pendientes SET enviado = 0 WHERE id = ? AND cancelado = 0`,
                { replacements: [record.id] },
              );
            }
            await registrarError(record, sendErr);
            await log(`[ms] ❌ id=${record.id} error enviando: ${sendErr.message}`);
            continue;
          }

          // ── Secuencia: programar el siguiente escalón si existe ──
          const secuenciaActual = Number(record.secuencia || 1);
          const [siguiente] = await db.query(
            `SELECT * FROM configuracion_remarketing
              WHERE id_configuracion = ? AND estado_contacto = ?
                AND secuencia = ? AND activo = 1
              LIMIT 1`,
            {
              replacements: [
                record.id_configuracion,
                record.estado_contacto_origen,
                secuenciaActual + 1,
              ],
              type: db.QueryTypes.SELECT,
            },
          );

          if (siguiente && siguiente.metodo_dentro_24h === 'ia' && siguiente.prompt_ia) {
            const minutos =
              siguiente.tiempo_espera_minutos != null
                ? Number(siguiente.tiempo_espera_minutos)
                : Number(siguiente.tiempo_espera_horas || 0) * 60;
            const tiempoDisparo = new Date(Date.now() + minutos * 60 * 1000);

            await db.query(
              `INSERT INTO remarketing_pendientes
                (telefono, id_cliente_chat_center, id_configuracion,
                 source, page_id, external_id,
                 estado_contacto_origen, estado_destino, tiempo_disparo,
                 metodo_dentro_24h, prompt_ia,
                 enviado, cancelado, secuencia)
               VALUES (?, ?, ?, 'ms', ?, ?, ?, ?, ?, 'ia', ?, 0, 0, ?)`,
              {
                replacements: [
                  String(record.external_id).slice(0, 20),
                  record.id_cliente_chat_center,
                  record.id_configuracion,
                  record.page_id,
                  record.external_id,
                  record.estado_destino || record.estado_contacto_origen,
                  siguiente.estado_destino || null,
                  tiempoDisparo,
                  siguiente.prompt_ia,
                  secuenciaActual + 1,
                ],
                type: db.QueryTypes.INSERT,
              },
            );
            await log(`[ms] 🟩 id=${record.id} secuencia ${secuenciaActual + 1} programada`);
          } else {
            await db.query(
              `UPDATE clientes_chat_center SET enviar_remarketing = 0 WHERE id = ?`,
              { replacements: [record.id_cliente_chat_center], type: db.QueryTypes.UPDATE },
            );
          }

          if (record.estado_destino) {
            await db.query(
              `UPDATE clientes_chat_center SET estado_contacto = ? WHERE id = ?`,
              {
                replacements: [record.estado_destino, record.id_cliente_chat_center],
                type: db.QueryTypes.UPDATE,
              },
            );
          }

          await db.query(
            `UPDATE remarketing_pendientes
                SET enviado = 1, ultimo_intento_at = NOW() WHERE id = ?`,
            { replacements: [record.id], type: db.QueryTypes.UPDATE },
          );

          await new Promise((r) => setTimeout(r, 300));
        } catch (err) {
          await log(`[ms] ❌ Error record id=${record.id}: ${err.message}`);
          try {
            await registrarError(record, err);
          } catch (_) {}
        }
      }
    });
  } catch (e) {
    // Conexión MySQL muerta: no es un fallo del remarketing, el pool la
    // descarta y el tick del próximo minuto arranca con una sana.
    if (esConexionCerrada(e)) {
      await log(`[ms] ⚠️ Ciclo MS saltado: conexión MySQL cerrada (${e.message})`);
    } else {
      await log(`[ms] ❌ Error ciclo cron MS: ${e.message}`);
    }
  } finally {
    isRunning = false;
  }
});

console.log('🚀 [remarketing_ms] Cron registrado (cada 1 min)');
