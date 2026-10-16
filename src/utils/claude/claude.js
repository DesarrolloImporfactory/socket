// ════════════════════════════════════════════════════════════
// claude.js — el bot del kanban respondiendo con Claude (Anthropic).
//
// Es el equivalente de ejecutarConResponsesAPI (kanban_ia.service) para el
// proveedor «claude» de configuraciones.proveedor_ia. Lo que cambia respecto
// de OpenAI, y por qué el motor lo trata distinto:
//
//   · La API de Claude es SIN ESTADO: no hay previous_response_id. El motor
//     manda siempre el recap de la conversación (lo mismo que ya hace cuando
//     la cadena de OpenAI se rompe), así que acá solo llega un `input` ya
//     armado y se manda como único mensaje del usuario.
//   · No hay file_search ni vector stores: el catálogo tiene que ir INLINE en
//     las instrucciones (el motor fuerza el inline cuando el proveedor es
//     Claude). Los documentos subidos por el usuario (vector_store_docs_id)
//     NO llegan a Claude en esta fase.
//   · Las instrucciones van en `system` con cache_control: el prompt + el
//     catálogo se repiten en cada turno y es lo que más tokens pesa; cacheado
//     vale ~10 % del precio de entrada.
//   · El modelo de la columna es de OpenAI (gpt-…): si no es un modelo de
//     Claude se usa MODELO_CLAUDE_DEFECTO. Así el cliente no tiene que
//     re-configurar cada columna para probar Claude.
//   · Opus 5.5 piensa siempre; los tokens de razonamiento descuentan de
//     max_tokens, así que el tope de la columna (500) se sube a un piso y el
//     esfuerzo va en «low»: es un chat de ventas, no un problema difícil.
//   · fallbacks: "default": si un clasificador de seguridad declina la
//     respuesta, la API la vuelve a correr en el modelo de respaldo dentro de
//     la misma llamada (header server-side-fallback-2026-07-01).
// ════════════════════════════════════════════════════════════
'use strict';

const Anthropic = require('@anthropic-ai/sdk');

const MODELO_CLAUDE_DEFECTO = 'claude-opus-5-5';

/* Modelos que se ofrecen en el selector de la columna cuando el proveedor es
   Claude. value = id exacto de la API (sin sufijo de fecha). */
const MODELOS_CLAUDE = [
  { value: 'claude-opus-5-5', label: 'Claude Opus 5.5', recomendado: true },
  { value: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5' },
  { value: 'claude-haiku-5-5', label: 'Claude Haiku 5.5' },
];
const IDS_CLAUDE = MODELOS_CLAUDE.map((m) => m.value);

const esModeloClaude = (modelo) => /^claude-/i.test(String(modelo || ''));

/** El modelo que de verdad se manda: el de la columna si es de Claude, si no el defecto. */
function modeloClaude(modelo) {
  const m = String(modelo || '').trim();
  return IDS_CLAUDE.includes(m) ? m : MODELO_CLAUDE_DEFECTO;
}

// Con razonamiento, un tope de 500 deja la respuesta vacía: piso de 4000.
const PISO_MAX_TOKENS = 4000;

function cliente(api_key_claude) {
  return new Anthropic({ apiKey: api_key_claude, timeout: 60000, maxRetries: 1 });
}

/** Lanza si la llave no sirve (401). Un GET a /v1/models no gasta tokens. */
async function validarApiKeyClaude(api_key_claude) {
  await cliente(api_key_claude).models.list({ limit: 1 });
  return true;
}

/* ── Errores ──────────────────────────────────────────────────────────────
   El motor decide qué hacer según estos tres casos (como esSinSaldo y
   esApiKeyInvalida para OpenAI). Anthropic devuelve 400 invalid_request_error
   con «Your credit balance is too low…» cuando la cuenta no tiene saldo. */
function esSinSaldoClaude(err) {
  const msg = String(err?.message || err?.error?.message || '').toLowerCase();
  return /credit balance|insufficient credit|billing|too low/.test(msg);
}

function esApiKeyClaudeInvalida(err) {
  return err instanceof Anthropic.AuthenticationError || err?.status === 401;
}

function esRateLimitClaude(err) {
  return err instanceof Anthropic.RateLimitError || err?.status === 429;
}

/** Texto corto y legible del error, para el cartel del chat y el log. */
function mensajeErrorClaude(err) {
  const m = String(err?.error?.error?.message || err?.error?.message || err?.message || 'error desconocido');
  return m.replace(/\s+/g, ' ').slice(0, 200);
}

/**
 * Una respuesta del bot con Claude.
 * @param {object} p
 *   instructions            prompt de la columna (+ catálogo inline, + prefacio del wizard)
 *   additional_instructions bloque del producto del anuncio (se pega al final del system)
 *   input                   lo que ve el modelo este turno (recap + mensaje actual)
 *   model                   modelo de la columna (gpt-… o claude-…)
 *   max_tokens              tope de la columna
 *   api_key_claude          llave plana (ya pasada por leerApiKeyClaude)
 *   log                     función de log del motor (opcional)
 * @returns {{respuesta:string, response_id:string, total_tokens:number, usage:object}}
 *   `usage` tiene la misma forma que la de OpenAI ({ modelo, input, cached,
 *   output, reasoning }) para que el panel de consumo no distinga proveedores.
 */
async function ejecutarConClaude({
  instructions,
  additional_instructions,
  input,
  model,
  max_tokens,
  api_key_claude,
  log,
}) {
  const client = cliente(api_key_claude);
  const modelo = modeloClaude(model);

  let system = String(instructions || '');
  if (additional_instructions) system += '\n\n' + additional_instructions;

  const t0 = Date.now();
  const res = await client.beta.messages.create({
    model: modelo,
    max_tokens: Math.max(Number(max_tokens) || 0, PISO_MAX_TOKENS),
    // Chat de ventas: razonamiento corto. Opus 5.5 no deja apagarlo.
    output_config: { effort: 'low' },
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: String(input || '') }],
  });

  const u = res.usage || {};
  const usage = {
    modelo,
    input: (Number(u.input_tokens) || 0) + (Number(u.cache_read_input_tokens) || 0) + (Number(u.cache_creation_input_tokens) || 0),
    cached: Number(u.cache_read_input_tokens) || 0,
    output: Number(u.output_tokens) || 0,
    reasoning: 0,
  };

  if (typeof log === 'function') {
    try {
      const respaldo = (res.content || []).find((b) => b.type === 'fallback');
      await log(
        `⏱️ Claude ${res.model || modelo}: ${Date.now() - t0} ms · stop=${res.stop_reason} · ` +
          `input=${usage.input} (cache ${usage.cached}) · output=${usage.output}` +
          (respaldo ? ` · respaldo ${respaldo.from?.model} → ${respaldo.to?.model}` : ''),
      );
    } catch (_) {}
  }

  // Un rechazo de seguridad sin respaldo llega con 200 y stop_reason refusal:
  // se devuelve vacío y el motor lo trata como «sin respuesta».
  if (res.stop_reason === 'refusal') {
    if (typeof log === 'function') {
      await log(`🚫 Claude declinó responder (${res.stop_details?.category || 'sin categoría'}): ${res.stop_details?.explanation || ''}`).catch(() => {});
    }
    return { respuesta: '', response_id: res.id, total_tokens: usage.input + usage.output, usage };
  }

  const respuesta = (res.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim();

  return {
    respuesta,
    response_id: res.id,
    total_tokens: usage.input + usage.output,
    usage,
  };
}

module.exports = {
  MODELO_CLAUDE_DEFECTO,
  MODELOS_CLAUDE,
  IDS_CLAUDE,
  esModeloClaude,
  modeloClaude,
  validarApiKeyClaude,
  ejecutarConClaude,
  esSinSaldoClaude,
  esApiKeyClaudeInvalida,
  esRateLimitClaude,
  mensajeErrorClaude,
};
