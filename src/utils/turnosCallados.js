/* Turnos en los que el bot decidió CALLAR a propósito (pausa porque atiende
   una persona, número del equipo, o el modelo no tenía nada que agregar en una
   columna de espera).

   No queda mensaje nuestro en el chat, así que el último sigue siendo del
   cliente y el rescate de turnos perdidos (cron/rescatarTurnosPerdidos) lo
   tomaba por un turno caído: lo repetía cada 5 minutos durante dos horas, con
   una llamada a OpenAI por vuelta. Acá queda anotado cuándo se calló cada
   chat; el rescate salta los mensajes anteriores a esa marca.

   Los turnos que FALLAN no se anotan: esos se siguen reintentando como
   siempre. En memoria (una sola instancia, igual que agruparRafaga): un
   reinicio lo borra y a lo sumo se repite un turno. */

const MAX_ENTRADAS = 5000;
// 'cfg:cliente' → Date.now() del último silencio
const callados = new Map();

const clave = (id_configuracion, id_cliente) =>
  `${Number(id_configuracion)}:${Number(id_cliente)}`;

function anotarSilencio(id_configuracion, id_cliente) {
  const k = clave(id_configuracion, id_cliente);
  callados.delete(k); // reinsertar = queda como el más reciente
  callados.set(k, Date.now());
  if (callados.size > MAX_ENTRADAS) {
    callados.delete(callados.keys().next().value);
  }
}

/** ¿El bot ya calló a propósito DESPUÉS de ese mensaje del cliente? */
function calloDespuesDe(id_configuracion, id_cliente, fechaMensaje) {
  const ts = callados.get(clave(id_configuracion, id_cliente));
  if (!ts) return false;
  const t = new Date(fechaMensaje).getTime();
  return Number.isFinite(t) && ts >= t;
}

/* Respuesta que el bot generó y NO mandó porque una persona del negocio
   contestó antes (kanban_ia paso 9.4). OpenAI ya la guardó en la cadena como
   si hubiera salido, así que en el próximo turno el bot "recuerda" haberla
   dicho. Se anota acá para avisarle en ese turno que el cliente nunca la
   leyó (pedido de Daniel, 05-11-2026: que al retomar sea coherente con lo
   que escribió la persona). Se borra cuando el bot vuelve a mandar algo. */
const TTL_DESCARTADA_MS = 24 * 60 * 60 * 1000;
// 'cfg:cliente' → { texto, por, ts }
const descartadas = new Map();

function anotarRespuestaDescartada(id_configuracion, id_cliente, { texto, por }) {
  const k = clave(id_configuracion, id_cliente);
  descartadas.delete(k);
  descartadas.set(k, {
    texto: String(texto || '').trim().slice(0, 400),
    por: String(por || '').trim(),
    ts: Date.now(),
  });
  if (descartadas.size > MAX_ENTRADAS) {
    descartadas.delete(descartadas.keys().next().value);
  }
}

/** La respuesta descartada vigente de este chat, o null. No la borra. */
function verRespuestaDescartada(id_configuracion, id_cliente) {
  const k = clave(id_configuracion, id_cliente);
  const d = descartadas.get(k);
  if (!d) return null;
  if (Date.now() - d.ts > TTL_DESCARTADA_MS || !d.texto) {
    descartadas.delete(k);
    return null;
  }
  return d;
}

function olvidarRespuestaDescartada(id_configuracion, id_cliente) {
  descartadas.delete(clave(id_configuracion, id_cliente));
}

module.exports = {
  anotarSilencio,
  calloDespuesDe,
  anotarRespuestaDescartada,
  verRespuestaDescartada,
  olvidarRespuestaDescartada,
};
