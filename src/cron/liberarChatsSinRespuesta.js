/**
 * Cada 5 minutos, en horario hábil de Ecuador, devuelve a «En espera» los
 * chats que el vendedor no respondió en 3 horas hábiles (hoy solo la
 * configuración 242). La lógica y sus porqués están en
 * services/liberar_sin_respuesta.service.js.
 *
 * Solo corre dentro de la ventana (lunes a viernes, 8:00–17:59): el reloj
 * cuenta horas hábiles, así que fuera de horario ningún chat puede vencer.
 */

const cron = require('node-cron');
const { ejecutarPasada } = require('../services/liberar_sin_respuesta.service');

// Evita que una pasada lenta se pise con la siguiente en este proceso. Entre
// instancias no hace falta lock: la liberación es idempotente.
let enCurso = false;

cron.schedule(
  '*/5 8-17 * * 1-5',
  async () => {
    if (enCurso) return;
    enCurso = true;
    const t0 = Date.now();
    try {
      const { candidatos, liberados } = await ejecutarPasada();
      if (liberados.length) {
        console.log(
          `[liberar-sin-respuesta] ${liberados.length} chat(s) a En espera ` +
            `(de ${candidatos} con cliente esperando) en ${Date.now() - t0} ms: ` +
            liberados.map((c) => `${c.id}←${c.id_encargado}`).join(', '),
        );
      }
    } catch (err) {
      console.error('[liberar-sin-respuesta] Error en la pasada:', err.message);
    } finally {
      enCurso = false;
    }
  },
  { timezone: 'America/Guayaquil' },
);
