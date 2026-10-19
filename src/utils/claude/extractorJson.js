// ════════════════════════════════════════════════════════════
// extractorJson.js — «dame un JSON a partir de este texto», con el
// proveedor de la cuenta.
//
// Los extractores del motor (auto-orden de Dropi, ficha del pedido, novedades
// de Dropi) hacían cada uno su llamada a OpenAI con response_format
// json_object. Cuando la cuenta responde con Claude eso obligaba a tener
// también llave de OpenAI o la pieza no corría. Acá se decide una sola vez:
//
//   · proveedor claude + llave de Claude → Haiku 5.5 (salida estructurada si
//     hay esquema, o «solo JSON» si no).
//   · si no → gpt-4o-mini por chat/completions, exactamente como antes.
//
// Lanza si la API falla (quien llama ya tiene su catch); devuelve {} si el
// modelo no devolvió un JSON parseable.
// ════════════════════════════════════════════════════════════
'use strict';

const axios = require('axios');
const { usaClaude, claudeJson } = require('./claude');

async function extraerJsonIA({
  system,
  user,
  schema = null,
  api_key_openai = null,
  proveedor_ia = 'openai',
  api_key_claude = null,
  modeloOpenAI = 'gpt-4o-mini',
  timeout = 20000,
  max_tokens = 1500,
}) {
  if (usaClaude({ proveedor_ia, api_key_claude })) {
    const r = await claudeJson({
      api_key_claude,
      system,
      input: user,
      schema,
      max_tokens,
    });
    return r.json && typeof r.json === 'object' ? r.json : {};
  }

  if (!api_key_openai) {
    throw new Error('Sin API Key de OpenAI para el extractor');
  }
  const { data } = await axios.post(
    'https://api.openai.com/v1/chat/completions',
    {
      model: modeloOpenAI,
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: String(system || '') },
        { role: 'user', content: String(user || '') },
      ],
    },
    { headers: { Authorization: `Bearer ${api_key_openai}` }, timeout },
  );
  try {
    return JSON.parse(data?.choices?.[0]?.message?.content || '{}') || {};
  } catch (_) {
    return {};
  }
}

/** Con qué se va a extraer, para los logs. */
function proveedorExtractor({ proveedor_ia, api_key_claude } = {}) {
  return usaClaude({ proveedor_ia, api_key_claude }) ? 'claude' : 'openai';
}

module.exports = { extraerJsonIA, proveedorExtractor };
