/* Reclamo de wamid entrantes, para que una misma entrega de Meta no se procese
 * dos veces.
 *
 * El webhook ya consultaba la BD antes de procesar, pero eso es un SELECT
 * seguido de un INSERT con varios `await` en medio: cuando Meta reintenta la
 * entrega —y reintenta— las dos llegan a preguntar "¿ya está guardado?" antes
 * de que ninguna haya guardado nada, las dos reciben que no, y el mismo mensaje
 * del cliente termina disparando la IA dos veces: respuesta doble y foto doble.
 *
 * Acá el reclamo es SÍNCRONO: entre la consulta al Map y el `set` no hay ningún
 * `await`, así que en el bucle de eventos de Node no existe forma de que dos
 * entregas simultáneas se lo lleven las dos.
 *
 * Por qué esto y no un índice UNIQUE sobre `mensajes_clientes`: los echoes de
 * WhatsApp Business guardan una fila con el MISMO wamid que el mensaje que ya
 * se había guardado al enviarlo desde el celular. Un UNIQUE haría fallar ese
 * INSERT y dejaría de registrarse lo que se manda desde el teléfono.
 *
 * El reclamo caduca a propósito: si el procesamiento falla a mitad de camino no
 * queda fila en la BD, y conviene que el reintento de Meta pueda volver a
 * tomarlo. Cuando el procesamiento sí termina, la fila ya existe y de los
 * reintentos posteriores se encarga la consulta a la BD.
 *
 * Alcance: este proceso. Hoy la app corre en una sola instancia (`node
 * src/server.js`, sin cluster ni pm2 en modo fork múltiple). Si algún día se
 * levantan varias, esto deja de alcanzar y hay que mover el reclamo a una tabla
 * propia con UNIQUE sobre (id_wamid_mensaje, id_configuracion) —una tabla
 * aparte, NO `mensajes_clientes`, por lo de los echoes.
 */

const EN_PROCESO = new Map();
const VIGENCIA_MS = 60 * 1000;

/**
 * Intenta quedarse con el wamid.
 *
 * @param {string} clave  `${id_configuracion}|${wamid}`
 * @returns {boolean} true si le tocó procesarlo, false si ya lo tomó otra entrega
 */
function reclamarWamid(clave) {
  const ahora = Date.now();
  const previo = EN_PROCESO.get(clave);

  if (previo && ahora - previo < VIGENCIA_MS) return false;

  EN_PROCESO.set(clave, ahora);

  // Sin esto el Map crece para siempre en un proceso que no se reinicia.
  if (EN_PROCESO.size > 5000) {
    for (const [k, t] of EN_PROCESO) {
      if (ahora - t >= VIGENCIA_MS) EN_PROCESO.delete(k);
    }
  }

  return true;
}

module.exports = { reclamarWamid };
