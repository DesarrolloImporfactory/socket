/* Agrupa la ráfaga de mensajes de un cliente en un solo turno de IA.
 *
 * EL PROBLEMA
 * Cada mensaje entrante dispara su propio procesarMensajeKanban. Cuando el
 * cliente escribe en pedazos —"En la entrada de ocho" / "Hay un Servientrega",
 * 6 segundos de diferencia— corren dos turnos en paralelo: dos llamadas a
 * OpenAI, dos respuestas, y el bot contestándole dos veces a la misma persona.
 * En el caso que originó esto, además, cerró la venta en las dos y creó dos
 * órdenes en Dropi.
 *
 * Medido en la cfg 411 sobre 4.543 mensajes de cliente (14 días):
 *
 *     ≤3s    3.7%      ≤10s   15.9%
 *     ≤5s    7.5%      ≤15s   22.4%
 *     ≤7s   11.1%      ≤20s   26.7%
 *
 * O sea que uno de cada diez mensajes llega mientras el bot todavía está
 * pensando la respuesta al anterior.
 *
 * CÓMO FUNCIONA
 * El mensaje se guarda y la corrida espera una ventana corta. Si en ese rato
 * llega otro mensaje del mismo cliente, la corrida vieja se retira en silencio
 * y la nueva se queda con TODO el texto acumulado. Sobrevive una sola corrida,
 * que ve el mensaje completo del cliente y contesta una sola vez.
 *
 * Nadie pierde nada: no se descarta ningún mensaje del cliente ni ninguna
 * respuesta del bot. Es la diferencia con la alternativa —dejar correr las dos
 * y tirar la respuesta que quedó vieja—, que es más barata en latencia pero
 * puede dejar sin contestar lo que el cliente preguntó en el primer mensaje.
 *
 * EL COSTO
 * La ventana se le suma a CADA respuesta. Con 6 segundos, un bot que hoy tarda
 * entre 5 y 19s en contestar pasa a tardar entre 11 y 25s. Es el precio de no
 * contestar dos veces, y es la perilla a mover si se siente lento: bajarla
 * agrupa menos ráfagas, subirla agrupa más y responde más tarde.
 *
 * Alcance: este proceso, igual que dedupeWamid y dedupeAutoOrden. La app corre
 * en una sola instancia; con varias habría que mover esto a Redis.
 */

/* Ventana de espera.
 *
 * Tiene que ser estrictamente MAYOR que el hueco que se quiere agrupar: con
 * 6000 y los dos mensajes de la clienta separados por exactamente 6s, la
 * ventana vencía justo cuando llegaba el segundo y no agrupaba nada. 8s cubre
 * ese caso con margen y atrapa algo más del 11% de los mensajes.
 *
 * No agrupa TODO —un hueco de 15s se sigue yendo en dos turnos— y está bien:
 * la correctitud no depende de esto. Que no se cree una orden repetida ni salga
 * el resumen dos veces ya lo garantizan los candados de utils/dedupeAutoOrden.
 * Esto es lo que además evita que el cliente reciba dos respuestas.
 *
 * Es la perilla: subirla agrupa más ráfagas y responde más tarde, bajarla al
 * revés. */
const VENTANA_MS = 8000;

// id_cliente → { textos: [], seq, ts }
const pendientes = new Map();

const MAX_ENTRADAS = 5000;
// Una corrida que muere antes de tiempo (proceso caído, excepción rara) dejaría
// su entrada colgada. Se purga por antigüedad para que el Map no crezca solo.
const TTL_MS = 5 * 60 * 1000;

function purgarSiHaceFalta(ahora) {
  if (pendientes.size <= MAX_ENTRADAS) return;
  for (const [k, v] of pendientes) {
    if (ahora - v.ts >= TTL_MS) pendientes.delete(k);
  }
}

const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Espera a que el cliente termine de escribir y devuelve todo junto.
 *
 * @param {number|string} id_cliente
 * @param {string} texto            el mensaje que acaba de llegar
 * @param {number} [ventanaMs]      override de la ventana (para pruebas)
 * @returns {Promise<string|null>}  el texto acumulado si a esta corrida le toca
 *   contestar; `null` si llegó otro mensaje después y se encarga esa otra.
 */
async function esperarRafaga(id_cliente, texto, ventanaMs = VENTANA_MS) {
  const clave = String(id_cliente);
  const ahora = Date.now();

  let entrada = pendientes.get(clave);
  if (!entrada) {
    entrada = { textos: [], seq: 0, ts: ahora };
    pendientes.set(clave, entrada);
  }
  entrada.ts = ahora;

  const t = String(texto ?? '').trim();
  if (t) entrada.textos.push(t);

  // El turno de esta corrida. Si llega otro mensaje, sube el contador y este
  // número deja de ser el último.
  const miSeq = ++entrada.seq;
  purgarSiHaceFalta(ahora);

  await esperar(ventanaMs);

  // Llegó otro mensaje mientras esperábamos: esa corrida se queda con todo,
  // incluido el texto de esta. Retirarse acá es lo que evita la respuesta doble.
  if (entrada.seq !== miSeq) return null;

  pendientes.delete(clave);

  /* Si ninguno traía texto se devuelve el argumento ORIGINAL, sin tocar ni el
     tipo: una foto sin pie y un audio llegan con texto_mensaje = '' (ver el
     switch del webhook), y devolver `String(texto ?? '')` convertía un null en
     '' y hacía que el llamador creyera que hubo agrupación. Así ese camino
     queda exactamente como estaba. */
  return entrada.textos.length ? entrada.textos.join('\n') : texto;
}

/* Ventana adaptativa (2026-09-14).
 *
 * Los 8 s fijos se pagaban en TODOS los turnos, también en los que no hay
 * nada que agrupar: "2", "Quito", "a domicilio", "¿tiene garantía?". Medido
 * en producción ese día: 17,4 s de latencia media por respuesta de IA
 * (1.422 turnos), de los cuales 8 eran esta espera. La ráfaga que se quiere
 * agrupar es la del cliente que escribe en PEDAZOS ("En la entrada de ocho" /
 * "Hay un Servientrega"): frases sin cerrar. Un mensaje que ya viene cerrado
 * —termina en puntuación, es un número, un sí/no, una sola palabra— casi
 * nunca tiene continuación, y si la tiene el segundo mensaje corre su propio
 * turno después (el candado por cliente los serializa): dos respuestas
 * coherentes en vez de una junta, nunca una respuesta doble a lo mismo.
 *
 * Panel "Probar como cliente" (wamid.PANEL…): quien prueba escribe un mensaje
 * y espera; la ventana baja a 1,5 s para que la prueba no se sienta lenta sin
 * cambiar nada del camino de producción. */
const VENTANA_CORTA_MS = 3500;
const VENTANA_PRUEBA_MS = 1500;

const RE_RESPUESTA_CORTA =
  /^\s*(?:\d{1,3}|s[ií]|no|ok|okey|okay|dale|listo|claro|bueno|perfecto|vale|ya|gracias)\b[\s.!,]*$/i;

function ventanaPara(texto, { esPrueba = false } = {}) {
  if (esPrueba) return VENTANA_PRUEBA_MS;
  const t = String(texto ?? '').trim();
  if (!t) return VENTANA_MS; // foto/audio sin texto: el pie puede venir aparte
  if (/[.!?…]$/.test(t)) return VENTANA_CORTA_MS;
  if (RE_RESPUESTA_CORTA.test(t)) return VENTANA_CORTA_MS;
  // Una sola palabra ("Quito", "domicilio", "dos") es una respuesta, no un
  // pedazo de frase.
  if (!/\s/.test(t) && t.length <= 20) return VENTANA_CORTA_MS;
  // Respuesta cortita de 2-3 palabras ("a domicilio", "ya, dame 2", "el de
  // 2"). El pedazo de frase típico es más largo ("Hay un Servientrega",
  // "En la entrada de ocho") y sigue esperando los 8 s.
  const palabras = t.split(/\s+/).filter(Boolean);
  if (palabras.length <= 3 && t.length <= 16) return VENTANA_CORTA_MS;
  // Mensaje largo: ya dijo lo que tenía que decir.
  if (t.length >= 80) return VENTANA_CORTA_MS;
  return VENTANA_MS;
}

module.exports = {
  esperarRafaga,
  ventanaPara,
  VENTANA_MS,
  VENTANA_CORTA_MS,
  VENTANA_PRUEBA_MS,
};
