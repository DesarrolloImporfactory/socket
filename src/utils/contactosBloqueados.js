/**
 * contactosBloqueados — números a los que NINGÚN envío automático les escribe.
 *
 * Pedido del 16-oct-2026: una clienta pidió salir del programa, se la marcó
 * para que no le llegara cobranza y ese mismo día le llegó un masivo
 * programado por la línea de soporte (265). «Que ningún cron la mencione».
 *
 * La lista vive en `chat_center.contactos_bloqueados`
 * (contactos_bloqueados_migration.sql) y la leen los dos sistemas: los crons
 * de este socket (masivos programados, remarketing, recordatorios de citas,
 * encuestas) y los avisos automáticos de Imporsuit (cobranzas, campañas,
 * automatizaciones). Va por número, en todas las líneas.
 *
 * Solo frena lo automático: un asesor puede seguir contestándole a mano.
 * Se compara por los últimos 9 dígitos, igual que `celular_last9`.
 *
 * Para bloquear o desbloquear: `php scripts/bloquear_contacto.php` en
 * imporsutipro.
 */
const { db } = require('../database/config');

const TTL_MS = 60 * 1000;
let cache = { at: 0, set: new Set() };

function ultimos9(telefono) {
  const d = String(telefono || '').replace(/\D/g, '');
  return d.length >= 9 ? d.slice(-9) : '';
}

async function cargar() {
  if (Date.now() - cache.at < TTL_MS) return cache.set;
  try {
    const rows = await db.query(
      `SELECT celular_last9 FROM contactos_bloqueados`,
      { type: db.QueryTypes.SELECT },
    );
    cache = {
      at: Date.now(),
      set: new Set(rows.map((r) => String(r.celular_last9))),
    };
  } catch (e) {
    // Si la tabla no se puede leer se sigue con la última lista conocida:
    // un fallo aquí no puede frenar todos los envíos del sistema.
    console.error('[contactosBloqueados] no se pudo leer la lista:', e.message);
    cache.at = Date.now();
  }
  return cache.set;
}

/* Segunda lista: contactos bloqueados en WhatsApp desde el chat
   (services/whatsapp_bloqueo.service.js, tabla `whatsapp_bloqueados`). A
   diferencia de la de arriba va POR CONEXIÓN: Meta rechaza cualquier envío de
   esa línea a ese número, así que intentarlo solo gasta. Se consulta aquí
   para que los crons tengan una sola pregunta que hacer. */
let cacheWa = { at: 0, set: new Set() };

async function cargarWa() {
  if (Date.now() - cacheWa.at < TTL_MS) return cacheWa.set;
  try {
    const rows = await db.query(
      `SELECT id_configuracion, celular FROM whatsapp_bloqueados`,
      { type: db.QueryTypes.SELECT },
    );
    cacheWa = {
      at: Date.now(),
      set: new Set(
        rows.map((r) => `${r.id_configuracion}:${ultimos9(r.celular)}`),
      ),
    };
  } catch (e) {
    console.error(
      '[contactosBloqueados] no se pudo leer whatsapp_bloqueados:',
      e.message,
    );
    cacheWa.at = Date.now();
  }
  return cacheWa.set;
}

/** Tras bloquear/desbloquear: que el próximo cron lea la lista fresca. */
function olvidarBloqueadosWhatsapp() {
  cacheWa.at = 0;
}

/**
 * ¿Ese número no debe recibir envíos automáticos?
 * Con `id_configuracion` también cuenta el bloqueo en WhatsApp de esa conexión.
 */
async function estaBloqueado(telefono, id_configuracion = null) {
  const clave = ultimos9(telefono);
  if (!clave) return false;
  if ((await cargar()).has(clave)) return true;
  if (!id_configuracion) return false;
  return (await cargarWa()).has(`${id_configuracion}:${clave}`);
}

module.exports = { estaBloqueado, ultimos9, olvidarBloqueadosWhatsapp };
