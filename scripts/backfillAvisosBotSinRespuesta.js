'use strict';

/**
 * Deja, hacia atrás, el aviso "el bot no respondió" en los chats que quedaron
 * sin respuesta durante una ventana conocida (p. ej. una cuenta sin saldo en
 * OpenAI que se detectó por el debug_log del servidor).
 *
 * El aviso normal lo escribe el propio turno de IA en el momento del fallo
 * (kanban_ia.service → avisarEnChatBotSinRespuesta); este script es para los
 * chats anteriores a ese cambio, o para una ventana que se descubrió después.
 *
 * Qué hace por cada chat de la configuración:
 *   - toma cada mensaje del cliente (rol 0) dentro de la ventana;
 *   - si en los 20 minutos siguientes no hubo respuesta de la IA ni de una
 *     persona (rol 1 que no sea un remarketing del cron), inserta la
 *     notificación rol 3 'sistema_ia' fechada 1 segundo después de ese
 *     mensaje, para que en el chat quede exactamente donde el bot calló;
 *   - una por chat: si ya hay un aviso del sistema después de ese mensaje,
 *     no se repite.
 *
 * Uso:
 *   node scripts/backfillAvisosBotSinRespuesta.js --cfg 320 \
 *     --desde "2026-09-24 06:02:00" --hasta "2026-09-24 08:24:00"            (solo muestra)
 *   node scripts/backfillAvisosBotSinRespuesta.js --cfg 320 --desde ... --hasta ... --aplicar
 *   [--texto "..."]  cambia el texto (por defecto el de sin saldo)
 *
 * Las fechas van en hora de la BD (Ecuador, -05:00).
 */

require('dotenv').config();
const { db } = require('../src/database/config');

const RESPONSABLE_AVISO_SISTEMA = 'sistema_ia';
const TEXTO_SIN_SALDO =
  '🤖 El bot no respondió: la cuenta de OpenAI se quedó sin saldo. ' +
  'Al recargar, el bot retoma este chat automáticamente.';
const MINUTOS_ESPERA = 20;

function arg(nombre, porDefecto = null) {
  const i = process.argv.indexOf(`--${nombre}`);
  if (i === -1) return porDefecto;
  return process.argv[i + 1] ?? porDefecto;
}

(async () => {
  const cfg = Number(arg('cfg'));
  const desde = arg('desde');
  const hasta = arg('hasta');
  const texto = arg('texto', TEXTO_SIN_SALDO);
  const aplicar = process.argv.includes('--aplicar');
  if (!cfg || !desde || !hasta) {
    console.log('Faltan --cfg, --desde y --hasta. Ver el encabezado del script.');
    process.exit(1);
  }

  const [propietario] = await db.query(
    `SELECT id FROM clientes_chat_center
      WHERE id_configuracion = ? AND propietario = 1 LIMIT 1`,
    { replacements: [cfg], type: db.QueryTypes.SELECT },
  );

  // Último mensaje del cliente por chat dentro de la ventana, sin respuesta
  // real en los 20 min siguientes y sin aviso del sistema posterior.
  const candidatos = await db.query(
    `SELECT m.id, m.celular_recibe AS id_cliente, m.created_at,
            LEFT(m.texto_mensaje, 60) AS texto
       FROM mensajes_clientes m
      WHERE m.id_configuracion = :cfg
        AND m.rol_mensaje = 0 AND m.deleted_at IS NULL
        AND m.created_at BETWEEN :desde AND :hasta
        AND m.id = (SELECT MAX(x.id) FROM mensajes_clientes x
                     WHERE x.id_configuracion = m.id_configuracion
                       AND x.celular_recibe = m.celular_recibe
                       AND x.rol_mensaje = 0 AND x.deleted_at IS NULL
                       AND x.created_at BETWEEN :desde AND :hasta)
        AND NOT EXISTS (
              SELECT 1 FROM mensajes_clientes r
               WHERE r.id_configuracion = m.id_configuracion
                 AND r.celular_recibe = m.celular_recibe
                 AND r.rol_mensaje = 1 AND r.deleted_at IS NULL
                 AND r.id > m.id
                 AND r.created_at <= m.created_at + INTERVAL :espera MINUTE
                 AND (r.responsable IS NULL OR r.responsable NOT LIKE 'cron_remarketing%')
            )
        AND NOT EXISTS (
              SELECT 1 FROM mensajes_clientes a
               WHERE a.id_configuracion = m.id_configuracion
                 AND a.celular_recibe = m.celular_recibe
                 AND a.rol_mensaje = 3 AND a.responsable = :aviso
                 AND a.id > m.id
            )
        /* Solo chats con el bot prendido y en una columna con IA activa: ahí
           el silencio fue un fallo. En columnas sin IA (asesor, guía
           generada…) el bot calla a propósito y no hay nada que avisar. */
        AND EXISTS (
              SELECT 1 FROM clientes_chat_center cli
              JOIN kanban_columnas k
                ON k.id_configuracion = cli.id_configuracion
               AND k.estado_db = cli.estado_contacto AND k.activa_ia = 1
               WHERE cli.id = CAST(m.celular_recibe AS UNSIGNED)
                 AND cli.id_configuracion = m.id_configuracion
                 AND cli.bot_openia = 1
            )
      ORDER BY m.id`,
    {
      replacements: { cfg, desde, hasta, espera: MINUTOS_ESPERA, aviso: RESPONSABLE_AVISO_SISTEMA },
      type: db.QueryTypes.SELECT,
    },
  );

  console.log(
    `cfg ${cfg} · ventana ${desde} → ${hasta} · chats sin respuesta: ${candidatos.length}${aplicar ? '' : ' (solo muestra; agrega --aplicar)'}`,
  );
  for (const c of candidatos) {
    console.log(`  chat ${c.id_cliente} · msg ${c.id} · ${c.created_at} · "${c.texto}"`);
    if (!aplicar) continue;
    await db.query(
      `INSERT INTO mensajes_clientes
         (id_configuracion, id_cliente, mid_mensaje, tipo_mensaje, rol_mensaje,
          celular_recibe, responsable, texto_mensaje, visto, created_at, updated_at)
       VALUES (?, ?, NULL, 'notificacion', 3, ?, ?, ?, 0,
               ? + INTERVAL 1 SECOND, NOW())`,
      {
        replacements: [
          cfg,
          propietario?.id ?? Number(c.id_cliente),
          String(c.id_cliente),
          RESPONSABLE_AVISO_SISTEMA,
          texto,
          c.created_at,
        ],
        type: db.QueryTypes.INSERT,
      },
    );
  }
  if (aplicar) console.log(`listo: ${candidatos.length} aviso(s) insertado(s)`);
  await db.close();
})().catch((e) => {
  console.error('ERROR', e.message);
  process.exit(1);
});
