/**
 * Canales por usuario dentro de un departamento
 * (columna sub_usuarios_departamento.canales, ver
 * sub_usuarios_departamento_canales_migration.sql).
 *
 * Un sub-usuario asignado a un departamento puede recibir solo los chats de
 * ciertos canales de la conexión: 'wa' (WhatsApp), 'ms' (Messenger),
 * 'ig' (Instagram). Se guarda como lista separada por coma ("wa,ig").
 *
 * Mientras la migración no esté aplicada, `tieneColumnaCanales()` devuelve
 * false y tanto el CRUD de departamentos como el round robin siguen
 * funcionando exactamente como antes (todos reciben todo).
 */
const { db } = require('../database/config');

const CANALES = ['wa', 'ms', 'ig'];
const CANAL_DEFAULT = 'wa';

let cache = null; // null = sin verificar
let cacheAt = 0;
const RECHECK_MS = 5 * 60 * 1000; // si aún no existe, se vuelve a mirar cada 5 min

async function tieneColumnaCanales() {
  const ahora = Date.now();
  if (cache === true) return true;
  if (cache === false && ahora - cacheAt < RECHECK_MS) return false;
  try {
    const rows = await db.query(
      "SHOW COLUMNS FROM sub_usuarios_departamento LIKE 'canales'",
      { type: db.QueryTypes.SELECT },
    );
    cache = rows.length > 0;
  } catch (_) {
    cache = false;
  }
  cacheAt = ahora;
  return cache;
}

/** Normaliza cualquier entrada (array, "wa,ig", null) a un array válido. */
function normalizarCanales(input) {
  const arr = Array.isArray(input)
    ? input
    : String(input || '')
        .split(',')
        .map((s) => s.trim());
  const limpios = [...new Set(arr.map((c) => String(c || '').toLowerCase()))]
    .filter((c) => CANALES.includes(c));
  return limpios.length ? limpios : [CANAL_DEFAULT];
}

function canalesToStr(input) {
  return normalizarCanales(input).join(',');
}

/** source de un cliente ('wa' | 'ms' | 'ig' | 'owner' | null) → canal válido */
function canalDeSource(source) {
  const s = String(source || '').toLowerCase();
  return CANALES.includes(s) ? s : CANAL_DEFAULT;
}

/**
 * Canales que un sub-usuario atiende en una conexión (unión de sus filas en
 * los departamentos de esa conexión). Devuelve null = SIN restricción:
 * migración no aplicada, o el usuario no está asignado a ningún departamento
 * de la conexión (en ese caso manda la lógica de acceso de siempre).
 */
async function canalesDeUsuarioEnConfig(id_sub_usuario, id_configuracion) {
  if (!id_sub_usuario || !id_configuracion) return null;
  if (!(await tieneColumnaCanales())) return null;
  const filas = await db.query(
    `SELECT sud.canales
       FROM sub_usuarios_departamento sud
       JOIN departamentos_chat_center d ON d.id_departamento = sud.id_departamento
      WHERE d.id_configuracion = ? AND sud.id_sub_usuario = ?`,
    {
      replacements: [id_configuracion, id_sub_usuario],
      type: db.QueryTypes.SELECT,
    },
  );
  if (!filas.length) return null;
  const union = new Set();
  filas.forEach((f) => normalizarCanales(f.canales).forEach((c) => union.add(c)));
  return [...union];
}

/**
 * Fragmento SQL (sin AND inicial) que limita una lista de chats SIN encargado
 * a los canales del asesor. Los valores salen de la lista blanca CANALES, por
 * eso van literales. null = no filtrar. `col` es la columna source.
 */
function sqlFiltroCanales(canales, col = 'source') {
  if (!Array.isArray(canales) || !canales.length) return null;
  const validos = canales.filter((c) => CANALES.includes(c));
  if (!validos.length || validos.length === CANALES.length) return null;
  const lista = validos.map((c) => `'${c}'`).join(',');
  // Filas viejas sin source cuentan como WhatsApp
  return validos.includes('wa')
    ? `(${col} IN (${lista}) OR ${col} IS NULL OR ${col} = '')`
    : `${col} IN (${lista})`;
}

module.exports = {
  canalesDeUsuarioEnConfig,
  sqlFiltroCanales,
  CANALES,
  CANAL_DEFAULT,
  tieneColumnaCanales,
  normalizarCanales,
  canalesToStr,
  canalDeSource,
};
