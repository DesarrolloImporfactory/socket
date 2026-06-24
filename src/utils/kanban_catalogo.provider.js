const { db } = require('../database/config');
const {
  KANBAN_TEMPLATES_META,
  KANBAN_RESPUESTAS_RAPIDAS,
  DROPI_CONFIG_POR_DEFECTO,
  REMARKETING_POR_DEFECTO,
} = require('./kanban_catalogo.data');

const TIPOS_VALIDOS = [
  'templates_meta',
  'respuestas_rapidas',
  'remarketing',
  'dropi_config',
];

async function _getCustomItems(tipo) {
  try {
    const rows = await db.query(
      `SELECT id, item_key, data
       FROM kanban_catalogo_items
       WHERE tipo = ? AND activo = 1
       ORDER BY id ASC`,
      { replacements: [tipo], type: db.QueryTypes.SELECT },
    );
    return rows.map((r) => ({
      id: r.id,
      item_key: r.item_key,
      data: typeof r.data === 'string' ? JSON.parse(r.data) : r.data,
    }));
  } catch (err) {
    // Tabla no existe todavía u otro error de lectura → solo fábrica.
    console.error(
      `[kanban_catalogo.provider] custom (${tipo}) no disponible:`,
      err.message,
    );
    return [];
  }
}

// ── Templates Meta (key = name) ──
async function getTemplatesMetaMerged() {
  const custom = await _getCustomItems('templates_meta');
  const map = new Map();
  for (const t of KANBAN_TEMPLATES_META) {
    map.set(t.name, { ...t, _custom: false, _catalogo_id: null });
  }
  for (const c of custom) {
    const d = c.data || {};
    const name = d.name || c.item_key;
    map.set(name, { ...d, name, _custom: true, _catalogo_id: c.id });
  }
  return [...map.values()];
}

// ── Respuestas rápidas (key = atajo) ──
async function getRespuestasRapidasMerged() {
  const custom = await _getCustomItems('respuestas_rapidas');
  const map = new Map();
  for (const r of KANBAN_RESPUESTAS_RAPIDAS) {
    map.set(r.atajo, { ...r, _custom: false, _catalogo_id: null });
  }
  for (const c of custom) {
    const d = c.data || {};
    const atajo = d.atajo || c.item_key;
    map.set(atajo, { ...d, atajo, _custom: true, _catalogo_id: c.id });
  }
  return [...map.values()];
}

// ── Dropi config (key = estado_dropi) ──
async function getDropiConfigMerged() {
  const custom = await _getCustomItems('dropi_config');
  const map = new Map();
  for (const d of DROPI_CONFIG_POR_DEFECTO) {
    map.set(d.estado_dropi, { ...d, _custom: false, _catalogo_id: null });
  }
  for (const c of custom) {
    const d = c.data || {};
    const estado = d.estado_dropi || c.item_key;
    map.set(estado, {
      ...d,
      estado_dropi: estado,
      _custom: true,
      _catalogo_id: c.id,
    });
  }
  return [...map.values()];
}

// ── Remarketing (agrupado por estado_contacto; key de secuencia = nombre_template) ──
async function getRemarketingMerged() {
  const custom = await _getCustomItems('remarketing');
  const grupos = new Map();

  for (const g of REMARKETING_POR_DEFECTO) {
    grupos.set(g.estado_contacto, {
      estado_contacto: g.estado_contacto,
      secuencias: (g.secuencias || []).map((s) => ({
        ...s,
        _custom: false,
        _catalogo_id: null,
      })),
    });
  }

  for (const c of custom) {
    const d = c.data || {};
    const estado = d.estado_contacto;
    if (!estado) continue; // remarketing custom requiere estado_contacto
    const sec = {
      ...d,
      nombre_template: d.nombre_template || c.item_key,
      _custom: true,
      _catalogo_id: c.id,
    };
    if (!grupos.has(estado)) {
      grupos.set(estado, { estado_contacto: estado, secuencias: [] });
    }
    const grp = grupos.get(estado);
    const idx = grp.secuencias.findIndex(
      (x) => x.nombre_template === sec.nombre_template,
    );
    if (idx >= 0)
      grp.secuencias[idx] = sec; // override
    else grp.secuencias.push(sec);
  }

  return [...grupos.values()];
}

// ── Lookups de templates (incluye custom) para body / header media ──
// Usado por dropi_config y remarketing para resolver body_text y
// header_media_url de plantillas que pueden ser custom.
async function getTemplateLookups() {
  const templates = await getTemplatesMetaMerged();
  const bodyByName = new Map();
  const headerMediaByName = new Map();
  for (const t of templates) {
    const comps = t.components || [];
    const body = comps.find((c) => c.type === 'BODY');
    bodyByName.set(t.name, body?.text || null);
    const header = comps.find(
      (c) =>
        c.type === 'HEADER' &&
        ['IMAGE', 'VIDEO', 'DOCUMENT'].includes(c.format),
    );
    headerMediaByName.set(t.name, header?.example?.header_handle?.[0] || null);
  }
  return { bodyByName, headerMediaByName };
}

module.exports = {
  TIPOS_VALIDOS,
  getTemplatesMetaMerged,
  getRespuestasRapidasMerged,
  getDropiConfigMerged,
  getRemarketingMerged,
  getTemplateLookups,
};
