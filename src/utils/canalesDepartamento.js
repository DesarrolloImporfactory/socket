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

module.exports = {
  CANALES,
  CANAL_DEFAULT,
  tieneColumnaCanales,
  normalizarCanales,
  canalesToStr,
  canalDeSource,
};
