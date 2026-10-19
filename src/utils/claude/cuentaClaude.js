// ════════════════════════════════════════════════════════════
// cuentaClaude.js — a qué organización de Anthropic pertenece una API key.
//
// Mismo propósito que utils/openia/cuentaOpenAI.js: el saldo de Claude es por
// organización, y el cliente necesita saber en cuál vive la llave que pegó
// para recargar donde toca. Anthropic no expone el correo del dueño con una
// llave normal; sí el nombre de la organización (GET /v1/organizations/me,
// que responde 200 con una llave normal aunque la doc lo liste como Admin
// API) y los ids de organización y workspace en las cabeceras de cualquier
// llamada. Si algo falla devuelve null: nunca frena el guardado de la llave.
// ════════════════════════════════════════════════════════════
'use strict';

const axios = require('axios');

async function obtenerCuentaClaude(api_key) {
  const key = String(api_key || '').trim();
  if (!key) return null;
  const headers = { 'x-api-key': key, 'anthropic-version': '2023-06-01' };
  let organizacion = null;
  let organizacion_id = null;
  let workspace_id = null;
  try {
    const r = await axios.get('https://api.anthropic.com/v1/organizations/me', {
      headers,
      timeout: 8000,
    });
    organizacion = r.data?.name || null;
    organizacion_id = r.data?.id || r.headers?.['anthropic-organization-id'] || null;
  } catch (_) {
    /* sin nombre: abajo se intenta al menos el id */
  }
  try {
    const r = await axios.get('https://api.anthropic.com/v1/models?limit=1', {
      headers,
      timeout: 8000,
    });
    organizacion_id = organizacion_id || r.headers?.['anthropic-organization-id'] || null;
    workspace_id = r.headers?.['anthropic-workspace-id'] || null;
  } catch (_) {
    /* opcional */
  }
  if (!organizacion && !organizacion_id) return null;
  return { organizacion, organizacion_id, workspace_id };
}

module.exports = { obtenerCuentaClaude };
