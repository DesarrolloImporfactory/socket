// utils/openia/envioEnBloques.js
// Orquesta el envío de una respuesta de la IA repartida en 2-3 mensajes.
//
// Dos cosas que NO son negociables aquí:
//
//   1. El primer bloque se envía de forma síncrona y el resto en segundo
//      plano. Si se esperara toda la ráfaga, el webhook de Meta quedaría
//      bloqueado varios segundos de más (OpenAI ya se toma entre 5 y 19s) y
//      Meta reintentaría, duplicando respuestas.
//
//   2. Si el cliente vuelve a escribir a mitad de la ráfaga, los bloques
//      pendientes se cancelan. Sin esto la conversación se desordena: el
//      bot seguiría soltando pedazos de una respuesta que ya quedó vieja.
//
// La cancelación usa un contador de turno EN MEMORIA. Sirve porque el
// proceso es único; si algún día se levanta más de una instancia, esto hay
// que mover a Redis o a una columna en BD.
// ─────────────────────────────────────────────────────────────

const {
  dividirRespuestaIA,
  calcularDelayEscritura,
} = require('./dividirRespuestaIA');

// id_cliente → { turno, ts }
const turnos = new Map();

// Techo defensivo: si el Map crece demasiado se purgan las entradas viejas.
const MAX_ENTRADAS = 5000;
const TTL_MS = 60 * 60 * 1000; // 1 hora

function purgarSiHaceFalta() {
  if (turnos.size <= MAX_ENTRADAS) return;
  const limite = Date.now() - TTL_MS;
  for (const [k, v] of turnos) {
    if (v.ts < limite) turnos.delete(k);
  }
  // Si aun así sigue enorme (todo reciente), se vacía: perder el estado de
  // cancelación es inofensivo, solo implica no cortar alguna ráfaga.
  if (turnos.size > MAX_ENTRADAS) turnos.clear();
}

// Marca que llegó un mensaje nuevo del cliente. Todo bloque pendiente de un
// turno anterior queda invalidado. Devuelve el turno actual.
function nuevoTurno(id_cliente) {
  const actual = (turnos.get(id_cliente)?.turno || 0) + 1;
  turnos.set(id_cliente, { turno: actual, ts: Date.now() });
  purgarSiHaceFalta();
  return actual;
}

function turnoVigente(id_cliente, turno) {
  return (turnos.get(id_cliente)?.turno || 0) === turno;
}

const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

// ══════════════════════════════════════════════════════════════
// enviarEnBloques
//
// @param canal        adaptador con enviarTexto({texto, responsable, total_tokens})
// @param texto        respuesta ya limpia (sin tags de media ni de acciones)
// @param id_cliente   para poder cancelar la ráfaga
// @param turno        el devuelto por nuevoTurno() al inicio de este mensaje
// @param log          función de log del servicio (opcional)
// @param opciones     overrides de dividirRespuestaIA (maxMensajes, etc.)
//
// @returns {bloques, enviados, enSegundoPlano}
// ══════════════════════════════════════════════════════════════
async function enviarEnBloques({
  canal,
  texto,
  responsable,
  total_tokens,
  analytics = null,
  id_cliente,
  turno,
  log,
  opciones = {},
}) {
  const bloques = dividirRespuestaIA(texto, opciones);
  if (!bloques.length) return { bloques: 0, enviados: 0, enSegundoPlano: 0 };

  // ── Bloque 1: síncrono ────────────────────────────────────
  await canal.enviarTexto({
    texto: bloques[0],
    responsable,
    total_tokens,
    analytics,
  });

  if (bloques.length === 1) {
    return { bloques: 1, enviados: 1, enSegundoPlano: 0 };
  }

  // ── Bloques 2..n: en segundo plano ────────────────────────
  const restantes = bloques.slice(1);

  // Se lanza sin await a propósito: el webhook debe poder responder ya.
  (async () => {
    for (const bloque of restantes) {
      await esperar(calcularDelayEscritura(bloque));

      if (!turnoVigente(id_cliente, turno)) {
        await log?.(
          `✂️ Ráfaga cancelada: el cliente escribió mientras se enviaba (cliente=${id_cliente})`,
        );
        return;
      }

      try {
        // total_tokens ya se contabilizó en el primer bloque; no se repite.
        await canal.enviarTexto({
          texto: bloque,
          responsable,
          total_tokens: 0,
        });
      } catch (err) {
        await log?.(`⚠️ Error enviando bloque en ráfaga: ${err.message}`);
        return;
      }
    }
  })().catch(async (err) => {
    await log?.(`⚠️ Fallo inesperado en la ráfaga: ${err.message}`);
  });

  return {
    bloques: bloques.length,
    enviados: 1,
    enSegundoPlano: restantes.length,
  };
}

module.exports = { enviarEnBloques, nuevoTurno, turnoVigente };
