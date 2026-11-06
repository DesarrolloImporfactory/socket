const axios = require('axios');

/* Páginas que el usuario concedió en el login de Meta.
   /me/accounts NO trae las páginas de un portafolio elegidas con "solo las
   actuales": esas solo aparecen en granular_scopes del token (caso cfg 287,
   1598, 1542, 1570 · 06-11-2026). Además pagina de a 25. */

const SCOPES_DE_PAGINA = [
  'pages_show_list',
  'pages_read_engagement',
  'pages_manage_metadata',
  'pages_messaging',
];

const graphGet = async (version, path, params) =>
  (await axios.get(`https://graph.facebook.com/${version}/${path}`, { params }))
    .data;

// IDs de página con permiso granular (vacío si el usuario concedió "todas").
async function idsConcedidos({ userToken, app, version }) {
  if (!app?.id || !app?.secret) return [];
  try {
    const { data } = await graphGet(version, 'debug_token', {
      input_token: userToken,
      access_token: `${app.id}|${app.secret}`,
    });
    const ids = new Set();
    for (const g of data?.granular_scopes || []) {
      if (!SCOPES_DE_PAGINA.includes(g.scope)) continue;
      (g.target_ids || []).forEach((id) => ids.add(String(id)));
    }
    return [...ids];
  } catch (err) {
    console.warn(
      '[META_PAGINAS] debug_token falló:',
      err.response?.data?.error?.message || err.message,
    );
    return [];
  }
}

// Una página concreta; null si el token no tiene acceso (sin access_token).
async function obtenerPaginaConcedida({ userToken, pageId, version, fields }) {
  try {
    const p = await graphGet(version, String(pageId), {
      access_token: userToken,
      fields,
    });
    return p?.id && p?.access_token ? p : null;
  } catch {
    return null;
  }
}

/**
 * /me/accounts completo (paginado) + las páginas concedidas que no salen ahí.
 * `fields` debe incluir id,name,access_token.
 */
async function listarPaginasConcedidas({ userToken, app, version, fields }) {
  const paginas = [];
  let after = null;
  for (let i = 0; i < 10; i++) {
    const res = await graphGet(version, 'me/accounts', {
      access_token: userToken,
      fields,
      limit: 100,
      ...(after ? { after } : {}),
    });
    paginas.push(...(res?.data || []));
    after = res?.paging?.next ? res?.paging?.cursors?.after : null;
    if (!after) break;
  }

  const vistos = new Set(paginas.map((p) => String(p.id)));
  const faltan = (await idsConcedidos({ userToken, app, version })).filter(
    (id) => !vistos.has(id),
  );
  for (const pageId of faltan) {
    const p = await obtenerPaginaConcedida({ userToken, pageId, version, fields });
    if (p) paginas.push(p);
  }
  if (faltan.length) {
    console.log(
      `[META_PAGINAS] /me/accounts=${vistos.size} · fuera de /me/accounts: ` +
        `${faltan.length} concedidas, ${paginas.length - vistos.size} recuperadas`,
    );
  }
  return paginas;
}

module.exports = { listarPaginasConcedidas, obtenerPaginaConcedida };
