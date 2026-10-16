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

/** ¿Ese número está en la lista de no contactar? */
async function estaBloqueado(telefono) {
  const clave = ultimos9(telefono);
  if (!clave) return false;
  return (await cargar()).has(clave);
}

module.exports = { estaBloqueado, ultimos9 };
