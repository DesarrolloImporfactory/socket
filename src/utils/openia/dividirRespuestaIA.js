// utils/openia/dividirRespuestaIA.js
// Divide la respuesta del asistente en 2-3 mensajes naturales, para que la
// conversación se sienta humana sin caer en ráfagas tipo spam.
//
// Criterio: se corta por BLOQUES SEMÁNTICOS (línea en blanco), nunca por
// oración. El asistente ya escribe en bloques; solo hay que respetarlos.
//
// Reglas duras:
//   1. Texto corto (< 200 chars) → un solo mensaje, sin excepción.
//   2. Tope de 3 mensajes (configurable). El excedente se fusiona.
//   3. Nunca se rompe una lista: viñetas, numeradas y líneas con emoji
//      (🧑 Nombre:, 📞 Teléfono:) quedan pegadas a su línea introductoria.
//   4. Bloques muy cortos (< 45 chars) se fusionan con el vecino.
//   5. Marcador explícito [split] tiene prioridad sobre todo lo anterior,
//      para que un prompt pueda controlar los cortes manualmente.
//
// Función PURA: no envía nada, no toca DB. Solo texto → array de textos.
// ─────────────────────────────────────────────────────────────

const OPCIONES_DEFAULT = {
  // Debajo de este largo no se divide nunca
  minCharsParaDividir: 200,
  // Máximo de mensajes en los que se puede partir una respuesta
  maxMensajes: 3,
  // Bloques más cortos que esto se fusionan con el vecino
  minCharsBloque: 45,
  // Límite de la Cloud API de WhatsApp para mensajes de texto
  maxCharsMensaje: 4096,
};

// Viñetas (-, *, •), numeradas (1. 1)) o línea que arranca con emoji
const RE_ITEM_LISTA =
  /^\s*(?:[-*•]\s+|\d+[.)]\s+|[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}]\s*)/u;

const RE_MARCADOR_SPLIT = /\[split\]/gi;

// ══════════════════════════════════════════════════════════════
// dividirRespuestaIA
// @param {string} texto  Respuesta ya limpia (sin tags de media/acciones)
// @param {object} opts   Ver OPCIONES_DEFAULT
// @returns {string[]}    1..maxMensajes trozos listos para enviar
// ══════════════════════════════════════════════════════════════
function dividirRespuestaIA(texto, opts = {}) {
  const cfg = { ...OPCIONES_DEFAULT, ...opts };

  if (!texto || typeof texto !== 'string') return [];

  const limpio = normalizarSaltos(texto);
  if (!limpio) return [];

  // ── Regla 5: marcador explícito [split] manda sobre todo ──
  if (RE_MARCADOR_SPLIT.test(limpio)) {
    RE_MARCADOR_SPLIT.lastIndex = 0;
    const trozos = limpio
      .split(RE_MARCADOR_SPLIT)
      .map((t) => t.trim())
      .filter(Boolean);
    return aplicarTope(trozos, cfg).flatMap((t) => trocearLargo(t, cfg));
  }

  // ── Regla 1: respuesta corta → un solo mensaje ────────────
  if (limpio.length < cfg.minCharsParaDividir) {
    return trocearLargo(limpio, cfg);
  }

  // ── Partir por bloques (línea en blanco) ──────────────────
  let bloques = limpio
    .split(/\n\s*\n/)
    .map((b) => b.trim())
    .filter(Boolean);

  if (bloques.length <= 1) return trocearLargo(limpio, cfg);

  // ── Regla 3: pegar listas a su bloque introductorio ───────
  bloques = pegarListas(bloques);

  // ── Regla 4: fusionar bloques demasiado cortos ────────────
  bloques = fusionarCortos(bloques, cfg);

  // ── Regla 2: respetar el tope de mensajes ─────────────────
  bloques = aplicarTope(bloques, cfg);

  return bloques.flatMap((b) => trocearLargo(b, cfg));
}

// ══════════════════════════════════════════════════════════════
// calcularDelayEscritura
// Delay antes de enviar un trozo: simula que alguien lo escribe y
// además asegura el orden de entrega (la Cloud API no garantiza
// orden en envíos consecutivos muy rápidos).
// ══════════════════════════════════════════════════════════════
function calcularDelayEscritura(texto, { min = 800, max = 2200 } = {}) {
  const estimado = 500 + (texto?.length || 0) * 12;
  return Math.min(max, Math.max(min, estimado));
}

// ══════════════════════════════════════════════════════════════
// Helpers internos
// ══════════════════════════════════════════════════════════════

function normalizarSaltos(texto) {
  return texto
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Si un bloque ARRANCA con item de lista, es continuación del anterior:
// el asistente separó con línea en blanco el "necesito estos datos:" de
// la lista en sí, y mandarlos por separado se ve roto.
function pegarListas(bloques) {
  const out = [];
  for (const bloque of bloques) {
    const esContinuacion = RE_ITEM_LISTA.test(bloque.split('\n')[0]);
    if (esContinuacion && out.length) {
      out[out.length - 1] += `\n${bloque}`;
    } else {
      out.push(bloque);
    }
  }
  return out;
}

// Un mensaje suelto que diga solo "¡Gracias por tu compra!" se ve robótico:
// se pega al vecino.
function fusionarCortos(bloques, cfg) {
  const out = [];
  for (const bloque of bloques) {
    if (bloque.length < cfg.minCharsBloque && out.length) {
      out[out.length - 1] += `\n\n${bloque}`;
    } else {
      out.push(bloque);
    }
  }
  // Si el PRIMERO quedó corto, se fusiona hacia adelante
  if (out.length > 1 && out[0].length < cfg.minCharsBloque) {
    out[1] = `${out[0]}\n\n${out[1]}`;
    out.shift();
  }
  return out;
}

// Mientras sobren mensajes, se fusiona el par ADYACENTE más corto.
// Así el resultado queda balanceado en vez de dejar un último mensaje enorme.
function aplicarTope(bloques, cfg) {
  const out = [...bloques];
  while (out.length > cfg.maxMensajes) {
    let idx = 0;
    let menor = Infinity;
    for (let i = 0; i < out.length - 1; i++) {
      const suma = out[i].length + out[i + 1].length;
      if (suma < menor) {
        menor = suma;
        idx = i;
      }
    }
    out.splice(idx, 2, `${out[idx]}\n\n${out[idx + 1]}`);
  }
  return out;
}

// Salvaguarda: ningún mensaje puede superar el límite de la API.
// Caso raro; se parte por oración y en último recurso a lo bruto.
function trocearLargo(texto, cfg) {
  if (texto.length <= cfg.maxCharsMensaje) return [texto];

  const partes = [];
  let actual = '';
  for (const frase of texto.split(/(?<=[.!?¡¿\n])\s+/)) {
    if ((actual + ' ' + frase).trim().length > cfg.maxCharsMensaje) {
      if (actual) partes.push(actual.trim());
      actual = frase;
      while (actual.length > cfg.maxCharsMensaje) {
        partes.push(actual.slice(0, cfg.maxCharsMensaje));
        actual = actual.slice(cfg.maxCharsMensaje);
      }
    } else {
      actual = actual ? `${actual} ${frase}` : frase;
    }
  }
  if (actual.trim()) partes.push(actual.trim());
  return partes;
}

// ══════════════════════════════════════════════════════════════
// normalizarFormatoWhatsapp  (OPCIONAL — no se aplica por defecto)
// El asistente escribe markdown (**negrita**) y WhatsApp usa *negrita*,
// así que hoy llega literal "**$24.99**" al cliente.
// Se deja aparte para activarlo cuando se decida.
// ══════════════════════════════════════════════════════════════
function normalizarFormatoWhatsapp(texto) {
  if (!texto) return '';
  return texto
    .replace(/\*\*\*(.+?)\*\*\*/gs, '*_$1_*') // ***x*** → *_x_*
    .replace(/\*\*(.+?)\*\*/gs, '*$1*') // **x**   → *x*
    .replace(/(^|\s)__(.+?)__(?=\s|$)/gs, '$1_$2_'); // __x__   → _x_
}

module.exports = {
  dividirRespuestaIA,
  calcularDelayEscritura,
  normalizarFormatoWhatsapp,
  OPCIONES_DEFAULT,
};
