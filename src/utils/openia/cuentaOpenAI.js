// ════════════════════════════════════════════════════════════
// cuentaOpenAI.js
// A qué cuenta de OpenAI pertenece una API key.
//
// POR QUÉ EXISTE ESTE ARCHIVO
//
// El saldo de OpenAI es por ORGANIZACIÓN, no por key. Un cliente con varias
// cuentas (o un equipo donde cada quien generó la suya) termina recargando una
// organización mientras el bot consume de otra, y el "sin saldo" no se va. Pasó
// el 2026-09-21 con las configs 610 y 822: sus keys eran de la cuenta personal
// de otro correo, no de la organización que tenía los créditos.
//
// GET /v1/me devuelve quién creó la key (nombre, correo y sus organizaciones), y
// las cabeceras openai-organization / openai-project dicen en cuál de ellas vive
// ESA key. Responde 200 aunque la cuenta esté en cero, así que sirve justo
// cuando más se necesita.
//
// OJO: /v1/me no está en la documentación pública. Si OpenAI lo cambia o lo
// quita, esto devuelve null y la vista simplemente no muestra el dato. Nunca
// debe bloquear el guardado de una key.
// ════════════════════════════════════════════════════════════
const axios = require('axios');

async function obtenerCuentaOpenAI(api_key) {
  const key = String(api_key || '').trim();
  if (!key) return null;

  try {
    const { data, headers } = await axios.get('https://api.openai.com/v1/me', {
      headers: { Authorization: `Bearer ${key}` },
      timeout: 8000,
    });

    const orgSlug = headers?.['openai-organization'] || null;
    const proyectoId = headers?.['openai-project'] || null;

    // El usuario puede pertenecer a varias organizaciones; la de la key es la
    // que viene en la cabecera (coincide con orgs[].name).
    const orgs = Array.isArray(data?.orgs?.data) ? data.orgs.data : [];
    const org = orgs.find((o) => o?.name === orgSlug) || null;

    const proyectos = Array.isArray(org?.projects?.data)
      ? org.projects.data
      : [];
    const proyecto = proyectos.find((p) => p?.id === proyectoId) || null;

    return {
      nombre: data?.name || null,
      email: data?.email || null,
      organizacion: org?.title || orgSlug,
      organizacion_id: org?.id || null,
      organizacion_personal: Boolean(org?.personal),
      proyecto: proyecto?.title || proyecto?.name || null,
      proyecto_id: proyectoId,
    };
  } catch (err) {
    console.warn(
      '[cuentaOpenAI] no se pudo identificar la cuenta:',
      err?.response?.status || err?.message,
    );
    return null;
  }
}

module.exports = { obtenerCuentaOpenAI };
