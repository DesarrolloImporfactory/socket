/* Un turno de OpenAI a la vez por cliente.
 *
 * EL PROBLEMA
 * Cuando el cliente escribe dos mensajes con más de 8 segundos de diferencia,
 * la ráfaga (utils/agruparRafaga.js) ya no los agrupa y corren DOS turnos de
 * IA en paralelo. Por la Responses API eso bifurca la cadena de contexto: las
 * dos corridas leen el MISMO previous_response_id, cada una encadena su turno
 * sobre ese punto, y la última en guardar pisa a la otra — el turno de la
 * primera desaparece de la memoria del bot PARA SIEMPRE.
 *
 * Caso real (config 569, Edgar, 2026-08-19): el referral del anuncio y un
 * "Necesito un prod" llegaron con 13s de diferencia. La corrida del segundo
 * leyó la cadena antes de que la del referral guardara, y el bot preguntó
 * "¿Qué producto necesitas?" 4 segundos después de haber presentado el
 * shampoo. La rama del referral se perdió de la cadena.
 *
 * CÓMO FUNCIONA
 * Una cola de promesas por cliente. tomarTurnoCliente() espera a que la
 * corrida anterior del mismo cliente suelte su turno y devuelve la función
 * para soltar el propio (llamarla SIEMPRE en un finally). Quien espera y
 * después relee la cadena ve el response_id que la corrida anterior acaba de
 * guardar: la conversación queda en una sola rama y cada respuesta sabe lo
 * que la anterior respondió.
 *
 * EL COSTO
 * Solo espera quien llega mientras otra corrida del MISMO cliente sigue en
 * OpenAI: unos segundos extra en ese caso y cero en el resto. El tope evita
 * que una corrida colgada (proceso a medio morir, timeout raro) deje al
 * cliente sin bot: vencido el tope se corre igual — como antes del candado.
 *
 * Alcance: este proceso, igual que agruparRafaga, dedupeWamid y
 * dedupeAutoOrden. La app corre en una sola instancia; con varias habría que
 * mover esto a Redis. */

// Mayor que el timeout de la llamada a OpenAI (60s en ejecutarConResponsesAPI)
// más el guardado: si en 90s la corrida anterior no soltó, algo se murió y no
// tiene sentido seguir esperándola.
const ESPERA_MAX_MS = 90 * 1000;

// id_cliente → promesa que resuelve cuando el último turno en cola suelta.
const colas = new Map();

async function tomarTurnoCliente(id_cliente, esperaMaxMs = ESPERA_MAX_MS) {
  const clave = String(id_cliente);
  const previa = colas.get(clave) || Promise.resolve();

  let soltar;
  const propia = new Promise((resolve) => {
    soltar = resolve;
  });
  // La cola avanza recién cuando ESTE turno suelte (después de los previos).
  const cola = previa.then(() => propia);
  colas.set(clave, cola);

  // Esperar el turno, con tope por si la corrida anterior quedó colgada.
  let timer;
  await Promise.race([
    previa,
    new Promise((resolve) => {
      timer = setTimeout(resolve, esperaMaxMs);
    }),
  ]);
  clearTimeout(timer);

  let soltado = false;
  return function soltarTurno() {
    if (soltado) return;
    soltado = true;
    soltar();
    // Si nadie quedó en cola detrás, se limpia la entrada para que el Map no
    // crezca solo (mismo criterio que agruparRafaga).
    if (colas.get(clave) === cola) colas.delete(clave);
  };
}

module.exports = { tomarTurnoCliente, ESPERA_MAX_MS };
