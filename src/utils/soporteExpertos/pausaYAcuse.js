/**
 * Pausa por persona del equipo (E1) y acuse una sola vez (E4) en la cuenta de
 * Expertos (Daniel, 27-oct). Solo corre en las cuentas con soporte_expertos.
 *
 * E1 — La pausa de 45 min («alguien del equipo escribió, el bot no se mete»)
 * se activaba con cualquier mensaje con nombre de persona. Dos no cuentan:
 *   - un aviso masivo: el mismo texto que la cuenta mandó a 3 o más clientes
 *     distintos en ±6 h (difusiones, recordatorios de clase). Nadie está
 *     atendiendo ese chat; el cliente que contesta al aviso se quedaba mudo.
 *   - uno mandado fuera de oficina (horario_equipo): de noche o en fin de
 *     semana no hay una persona del otro lado esperando para seguir.
 *
 * E4 — «Recibí tu mensaje. Un asesor lo revisa…» salía en cada mensaje del
 * cliente mientras esperaba (hasta 5 seguidos el mismo día). Sale una sola vez
 * por chat: si la IA ya lo mandó en las últimas 12 h y nadie del equipo
 * escribió después, el siguiente no se manda.
 *
 * Pausa por persona (pedido de Johan, 28-oct) — «una vez que me escale a mí
 * ya no debería de meterse … quizá una hora de que no se le responde». La de
 * 45 min se acababa y el bot volvía a contestar encima de Johan (953642: él
 * escribió a las 9:05 y el bot 4 veces entre 9:53 y 9:56). Con
 * soporte_expertos.pausa_persona: si una persona escribió en las últimas
 * `horas`, en oficina el bot calla; si el cliente lleva `minutos` de oficina
 * sin respuesta, un solo T8 («Tu caso sigue con {nombre}…») y vuelve a callar.
 * Fuera de oficina, como antes.
 */

'use strict';

const { equipoAtendiendo, minutosHabiles } = require('./horario');
const { sinTildes } = require('./texto');
const T = require('./textos');
const { esAutomatico } = require('./seguimiento');
const { esResponsableHumano } = require('../ajustesIA');
const { normalizarParaBucle } = require('../antiBucle');

/* Un aviso masivo: el mismo texto a 3 o más clientes distintos en ±6 h. Los
   textos cortos («hola», «buenos días») no cuentan: los escribe una persona
   a varios a la vez y sí está atendiendo. */
const DESTINOS_MASIVO = 3;
const HORAS_MASIVO = 6;
const MIN_LETRAS_MASIVO = 40;

/**
 * El mensaje de una persona del equipo que pausa al bot, o null.
 * @param {{responsable:string, texto_mensaje?:string, seg:number}[]} recientes
 *   mensajes salientes de los últimos N min, el más reciente primero; `seg` =
 *   hace cuántos segundos salió.
 * @param {{ horarioEquipo?: object, ahora?: number,
 *   destinosDe?: (texto:string, seg:number) => Promise<number> }} opts
 *   destinosDe = a cuántos clientes distintos mandó la cuenta ese texto en ±6 h.
 */
async function humanoQuePausa(recientes, { horarioEquipo = null, ahora = Date.now(), destinosDe = null } = {}) {
  for (const m of Array.isArray(recientes) ? recientes : []) {
    if (!esResponsableHumano(m.responsable)) continue;
    const ts = ahora - Number(m.seg || 0) * 1000;
    if (horarioEquipo && !equipoAtendiendo(ts, horarioEquipo)) continue;
    const texto = String(m.texto_mensaje || '').trim();
    if (destinosDe && texto.length >= MIN_LETRAS_MASIVO) {
      try {
        if ((await destinosDe(texto, Number(m.seg || 0))) >= DESTINOS_MASIVO) continue;
      } catch {
        // Si no se pudo contar, cuenta como persona: mejor callar que meterse.
      }
    }
    return m;
  }
  return null;
}

const SQL_DESTINOS = `
  SELECT COUNT(DISTINCT celular_recibe) AS n FROM mensajes_clientes
   WHERE id_configuracion = ? AND rol_mensaje = 1 AND deleted_at IS NULL
     AND created_at BETWEEN NOW() - INTERVAL ? SECOND - INTERVAL ${HORAS_MASIVO} HOUR
                        AND NOW() - INTERVAL ? SECOND + INTERVAL ${HORAS_MASIVO} HOUR
     AND texto_mensaje = ?`;

/* Los acuses fijos del bot (textos.js), con cualquiera de sus finales según la
   hora («apenas abramos», «en breve», «mañana desde las 8:00»). El comprobante
   y «no lo puedo abrir» no están: cada uno dice algo nuevo. */
const INICIOS_ACUSE = [
  'recibi tu mensaje un asesor lo revisa',
  'recibi tu mensaje tu asesor lo revisa',
  'recibi tu mensaje el area de logistica revisa tu carga',
  'recibido lo sumo a tu caso para el asesor',
  'recibi lo que enviaste un asesor lo revisa',
  'recibimos tu mensaje un asesor te escribe',
];
const MAX_LETRAS_ACUSE = 160;

function esAcuse(texto) {
  const t = String(texto || '').trim();
  if (!t || t.length > MAX_LETRAS_ACUSE) return false;
  const n = normalizarParaBucle(t);
  return INICIOS_ACUSE.some((i) => n.startsWith(i));
}

/**
 * ¿Este acuse sobra? Sí, si la IA ya mandó uno en esta conversación y nadie
 * del equipo escribió después.
 * @param {string} nuevo
 * @param {{responsable:string, texto_mensaje:string}[]} salientes mensajes
 *   salientes de las últimas 12 h, el más reciente primero.
 */
function acuseRepetido(nuevo, salientes) {
  if (!esAcuse(nuevo)) return false;
  for (const m of Array.isArray(salientes) ? salientes : []) {
    if (esResponsableHumano(m.responsable)) return false;
    if (esAcuse(m.texto_mensaje)) return true;
  }
  return false;
}

/* ── Pausa por persona (Johan, 28-oct) ── */
const llano = (t) => sinTildes(String(t || '').toLowerCase()).replace(/[^a-z0-9ñ ]+/g, ' ').replace(/\s+/g, ' ').trim();
const PREFIJO_T8 = llano(T.PROACTIVO.sigue_con.split('{')[0]); // «tu caso sigue con»
const esDelBot = (m) => Number(m.rol) === 1 && /^IA_/i.test(String(m.resp || '')) && !/^IA_Seguimiento/i.test(String(m.resp || ''));
/* Remitentes que no son una persona atendiendo (además de los automáticos de
   seguimiento.js): «Soporte Importaciones» son los avisos de cargas (370
   mensajes a 155 chats en 14 días). */
const NO_ES_PERSONA = ['soporte importaciones'];
const cuentaComoPersona = (resp) => !esAutomatico(resp) && !NO_ES_PERSONA.includes(String(resp || '').trim().toLowerCase());
/* Lo escrito desde la app del celular sale como «Whatsapp Business»: es una
   persona, pero sin nombre para el T8. */
const SIN_NOMBRE = ['whatsapp business', 'imporfactory'];
// «Johan Bonilla ImporFactory» → «Johan»; sin nombre de persona, null.
const primerNombre = (resp) => {
  if (SIN_NOMBRE.includes(String(resp || '').trim().toLowerCase())) return null;
  const n = String(resp || '').trim().split(/\s+/)[0] || '';
  return /^[A-Za-zÁÉÍÓÚÑáéíóúñ]{2,}$/.test(n) ? n : null;
};

/**
 * ¿El bot calla porque una persona del equipo ya atiende el chat?
 * @param {{ mensajes: {rol:number, resp?:string, tx?:string, t:number}[],
 *   humano: {resp:string, t:number}|null, ahora?: number, horario?: object,
 *   minutos?: number, horas?: number }} p
 *   humano = el último mensaje de una persona que cuenta (humanoQuePausa:
 *   sin avisos masivos ni mensajes de fuera de oficina).
 * @returns {null|{accion:'callar', espera:number, t8Enviado?:boolean}
 *   |{accion:'t8', nombre:string, desde:number, espera:number}}
 *   null = el bot contesta como siempre; espera = minutos de oficina que lleva
 *   el cliente sin respuesta; desde = cuándo escribió esa persona.
 */
function decidirPausaPersona({ mensajes = [], humano = null, ahora = Date.now(), horario = null, minutos = 60, horas = 24 } = {}) {
  if (!humano || !Number.isFinite(Number(humano.t)) || !cuentaComoPersona(humano.resp)) return null;
  if (ahora - humano.t > horas * 3600 * 1000) return null;
  // De noche o en fin de semana nadie del equipo va a contestar: como antes.
  if (horario && !equipoAtendiendo(ahora, horario)) return null;
  const tras = (Array.isArray(mensajes) ? mensajes : []).filter((m) => m && Number(m.t) > humano.t).sort((a, b) => a.t - b.t);
  const primero = tras.find((m) => Number(m.rol) === 0);
  const espera = minutosHabiles(primero ? primero.t : ahora, ahora, horario || undefined);
  if (espera < minutos) return { accion: 'callar', espera };
  if (tras.some((m) => esDelBot(m) && llano(m.tx).startsWith(PREFIJO_T8))) return { accion: 'callar', espera, t8Enviado: true };
  const nombre = primerNombre(humano.resp);
  // Sin nombre no hay T8 que valga: pasado el plazo, el bot contesta como hoy.
  if (!nombre) return null;
  return { accion: 't8', nombre, desde: humano.t, espera };
}

module.exports = { humanoQuePausa, decidirPausaPersona, cuentaComoPersona, esAcuse, acuseRepetido, SQL_DESTINOS, DESTINOS_MASIVO, HORAS_MASIVO, MIN_LETRAS_MASIVO };
