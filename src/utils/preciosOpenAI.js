// utils/preciosOpenAI.js
// Precios públicos de OpenAI (USD por millón de tokens) para ESTIMAR el costo
// de las respuestas del bot. Son referenciales: la factura real la da OpenAI.
// Se actualizan a mano cuando cambian; la fecha de la última revisión va en
// ACTUALIZADO para que el panel lo diga.

const ACTUALIZADO = '2026-08';

// { input, cached (input cacheado), output } en USD por 1M tokens.
const PRECIOS = {
  'gpt-5': { input: 1.25, cached: 0.125, output: 10.0 },
  'gpt-5-mini': { input: 0.25, cached: 0.025, output: 2.0 },
  'gpt-5-nano': { input: 0.05, cached: 0.005, output: 0.4 },
  'gpt-4.1': { input: 2.0, cached: 0.5, output: 8.0 },
  'gpt-4.1-mini': { input: 0.4, cached: 0.1, output: 1.6 },
  'gpt-4.1-nano': { input: 0.1, cached: 0.025, output: 0.4 },
  'gpt-4o': { input: 2.5, cached: 1.25, output: 10.0 },
  'gpt-4o-mini': { input: 0.15, cached: 0.075, output: 0.6 },
  'gpt-3.5-turbo': { input: 0.5, cached: 0.5, output: 1.5 },
};

const MODELO_DEFECTO = 'gpt-4o-mini';

/** "gpt-4o-mini-2024-07-18" → "gpt-4o-mini". Desconocido → gpt-4o-mini. */
function normalizarModelo(modelo) {
  const m = String(modelo || '').toLowerCase().trim();
  if (!m) return MODELO_DEFECTO;
  if (PRECIOS[m]) return m;
  // quitar sufijo de fecha / variantes
  const base = m.replace(/-\d{4}-\d{2}-\d{2}$/, '').replace(/-preview$/, '');
  if (PRECIOS[base]) return base;
  const claves = Object.keys(PRECIOS).sort((a, b) => b.length - a.length);
  const hit = claves.find((k) => base.startsWith(k));
  return hit || MODELO_DEFECTO;
}

function precioDe(modelo) {
  return PRECIOS[normalizarModelo(modelo)];
}

/** Costo exacto en USD a partir del uso real de una respuesta. */
function costoUSD({ modelo, input = 0, cached = 0, output = 0 }) {
  const p = precioDe(modelo);
  const inputNoCache = Math.max(0, Number(input) - Number(cached));
  return (
    (inputNoCache * p.input + Number(cached) * p.cached + Number(output) * p.output) /
    1e6
  );
}

/**
 * Estimación cuando solo se conoce el total de tokens (mensajes viejos, sin
 * desglose): en las respuestas del bot ~95% es entrada (prompt + catálogo +
 * historial) y ~5% salida.
 */
function costoEstimadoPorTokens(modelo, total_tokens) {
  const t = Number(total_tokens) || 0;
  return costoUSD({ modelo, input: t * 0.95, output: t * 0.05 });
}

/**
 * Costo típico de UNA respuesta, para mostrar al elegir modelo: ~12k tokens
 * de contexto (prompt + catálogo + historial) y una respuesta corta (~150
 * tokens; los modelos de razonamiento suman ~300 de razonamiento).
 */
function costoTipicoPorRespuesta(modelo) {
  const m = normalizarModelo(modelo);
  const razona = /^gpt-5/.test(m);
  return costoUSD({ modelo: m, input: 12000, output: razona ? 450 : 150 });
}

module.exports = {
  ACTUALIZADO,
  PRECIOS,
  MODELO_DEFECTO,
  normalizarModelo,
  precioDe,
  costoUSD,
  costoEstimadoPorTokens,
  costoTipicoPorRespuesta,
};
