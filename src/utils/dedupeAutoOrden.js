/* Candado anti-duplicado para la creación automática de órdenes Dropi.
 *
 * EL PROBLEMA
 * El cliente manda dos mensajes seguidos ("En la entrada de ocho" / "Hay un
 * Servientrega"). Cada mensaje entrante dispara su propio procesarMensajeKanban
 * —no hay agrupación de ráfagas— y el asistente cierra la venta en LAS DOS
 * respuestas, cada una con su bloque de resumen y su tag. El disparo de
 * `cambiar_estado → generar_guia` no miraba si ya había una orden en curso, así
 * que se creaban dos órdenes en Dropi con segundos de diferencia. Pasó 6 veces
 * en la cfg 411 (la del Dr Melaxin), con separaciones de 2, 3, 8, 11, 12 y 193
 * segundos.
 *
 * POR QUÉ ACÁ Y NO SOLO EN LA BD
 * El log (`dropi_auto_ordenes_log`) se escribe DESPUÉS de crear la orden en
 * Dropi, y crear tarda entre 10 y 40 segundos —más si Dropi contesta 429 y
 * `conReintento429` espera. En esa ventana una consulta a la BD no ve nada
 * todavía: las dos corridas preguntarían "¿ya hay orden?", las dos recibirían
 * que no, y las dos crearían. Acá el reclamo es SÍNCRONO —entre el `get` y el
 * `set` no hay ningún `await`— así que en el bucle de eventos de Node no existe
 * forma de que dos corridas simultáneas se lo lleven las dos. Es el mismo
 * criterio de utils/dedupeWamid.js.
 *
 * DOS ESTADOS, A PROPÓSITO
 *  - `en_vuelo`: una corrida está trabajando. Si termina SIN crear (producto sin
 *    match, ciudad sin cod_dane, etc.) se libera enseguida: un fallo no puede
 *    dejar al cliente sin poder reintentar en el próximo mensaje.
 *  - `creada`: la orden se creó. Queda pegajosa un rato para tapar el caso del
 *    resumen repetido con minutos de diferencia (el de 193s), que ya no es una
 *    carrera sino el bot cerrando la venta dos veces.
 *
 * Alcance: este proceso. Hoy la app corre en una sola instancia (`node
 * src/server.js`, sin cluster). La verificación contra `dropi_auto_ordenes_log`
 * que vive en dropiAutoOrder.service.js es la red de abajo: cubre los reinicios
 * del proceso —que vacían este Map— y las órdenes creadas por otra vía (el
 * panel de "pedidos sin subir").
 */

const ESTADO = new Map(); // clave → { estado: 'en_vuelo'|'creada', ts }

// Techo del reclamo en vuelo. Crear una orden son 5-6 llamadas a Dropi y, si
// alguna devuelve 429, conReintento429 espera 2 minutos por intento. 10 minutos
// deja margen de sobra y evita que una corrida que murió sin avisar —proceso
// caído a mitad— deje al cliente bloqueado para siempre.
const VIGENCIA_EN_VUELO_MS = 10 * 60 * 1000;

// Ventana pegajosa tras crear. El duplicado real más separado que se registró
// fueron 193 segundos; 30 minutos da margen amplio. Acotado a propósito: si el
// mismo cliente compra otra vez más tarde, esa venta SÍ tiene que poder subir.
const VIGENCIA_CREADA_MS = 30 * 60 * 1000;

const MAX_ENTRADAS = 5000;

function vigenciaDe(estado) {
  return estado === 'creada' ? VIGENCIA_CREADA_MS : VIGENCIA_EN_VUELO_MS;
}

function purgarSiHaceFalta(ahora) {
  if (ESTADO.size <= MAX_ENTRADAS) return;
  for (const [k, v] of ESTADO) {
    if (ahora - v.ts >= vigenciaDe(v.estado)) ESTADO.delete(k);
  }
}

/**
 * Intenta quedarse con la creación de orden de este cliente.
 *
 * @param {string} clave `${id_configuracion}|${id_cliente}`
 * @returns {boolean} true si le toca crearla, false si ya hay una corrida en
 *   vuelo o se creó una hace poco.
 */
function reclamarAutoOrden(clave) {
  const ahora = Date.now();
  const previo = ESTADO.get(clave);

  if (previo && ahora - previo.ts < vigenciaDe(previo.estado)) return false;

  ESTADO.set(clave, { estado: 'en_vuelo', ts: ahora });
  purgarSiHaceFalta(ahora);
  return true;
}

/** La orden se creó: la marca pasa a pegajosa. */
function confirmarAutoOrden(clave) {
  ESTADO.set(clave, { estado: 'creada', ts: Date.now() });
}

/**
 * La corrida terminó sin crear orden (fallo, gate apagado, duplicado
 * detectado). Se suelta para que el próximo mensaje pueda reintentar.
 * No pisa una marca 'creada': si la corrida se descartó justamente porque ya
 * había orden, soltar el candado reabriría la puerta al duplicado.
 */
function liberarAutoOrden(clave) {
  if (ESTADO.get(clave)?.estado === 'creada') return;
  ESTADO.delete(clave);
}

module.exports = {
  reclamarAutoOrden,
  confirmarAutoOrden,
  liberarAutoOrden,
};
