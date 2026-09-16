/**
 * Registro en BD de los tramos conectados de cada sub-usuario (tabla
 * presencia_sesiones). La presencia en sí sigue viviendo en memoria
 * (presenceStore); esto solo deja historial para poder mostrarle al cliente
 * cuánto tiempo estuvo conectada cada persona de su equipo.
 *
 * - abrir(): al pasar de offline a online inserta una fila y guarda su id.
 * - cerrar(): al quedar sin sockets cierra la fila (fin, duracion, cerrada=1).
 * - Cada TOUCH_MS se "toca" el fin de las filas abiertas de ESTE proceso.
 *   Así, si el server se reinicia, el tramo queda cortado como mucho 5 min
 *   antes del reinicio en vez de quedar abierto para siempre. No se cierran
 *   filas ajenas al arrancar: dev y prod comparten BD y un arranque local
 *   cerraría las sesiones vivas de producción.
 *
 * Todo va en try/catch: si la tabla no existe todavía, la presencia sigue
 * funcionando igual y solo se pierde el historial.
 */
const { db } = require('../../database/config');
const PresenciaSesiones = require('../../models/presencia_sesiones.model');

const TOUCH_MS = 5 * 60 * 1000;

// id_sub_usuario -> id de la fila abierta en presencia_sesiones
const abiertas = new Map();

const log = (...a) => console.warn('[PRESENCE][sesiones]', ...a);

async function abrir(id_sub_usuario, id_usuario) {
  const id = Number(id_sub_usuario);
  if (!id || abiertas.has(id)) return;
  try {
    const inicio = new Date();
    const fila = await PresenciaSesiones.create({
      id_sub_usuario: id,
      id_usuario: Number(id_usuario) || null,
      inicio,
      fin: inicio,
      duracion_seg: 0,
      cerrada: 0,
    });
    abiertas.set(id, fila.id);
  } catch (e) {
    log('no se pudo abrir sesión', id, e.message);
  }
}

async function cerrar(id_sub_usuario) {
  const id = Number(id_sub_usuario);
  const filaId = abiertas.get(id);
  if (!filaId) return;
  abiertas.delete(id);
  try {
    await db.query(
      `UPDATE presencia_sesiones
          SET fin = NOW(),
              duracion_seg = TIMESTAMPDIFF(SECOND, inicio, NOW()),
              cerrada = 1
        WHERE id = :filaId`,
      { replacements: { filaId }, type: db.QueryTypes.UPDATE },
    );
  } catch (e) {
    log('no se pudo cerrar sesión', id, e.message);
  }
}

async function tocarAbiertas() {
  if (!abiertas.size) return;
  const ids = [...abiertas.values()];
  try {
    await db.query(
      `UPDATE presencia_sesiones
          SET fin = NOW(),
              duracion_seg = TIMESTAMPDIFF(SECOND, inicio, NOW())
        WHERE id IN (:ids) AND cerrada = 0`,
      { replacements: { ids }, type: db.QueryTypes.UPDATE },
    );
  } catch (e) {
    log('no se pudo tocar sesiones abiertas', e.message);
  }
}

let timer = null;
function iniciarTouch() {
  if (timer) return;
  timer = setInterval(tocarAbiertas, TOUCH_MS);
  if (typeof timer.unref === 'function') timer.unref();
}

module.exports = { abrir, cerrar, iniciarTouch };
