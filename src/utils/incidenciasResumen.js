/* ═══════════════════════════════════════════════════════════
   Incidencias de un contacto, resumidas (para las tarjetas del kanban)

   La bitácora de incidencias (incidencias_chat_center) se escribe desde el
   panel derecho de /chat. Las cuentas que la usan necesitan verla también en
   /estado_contactos sin abrir el chat: la tarjeta muestra la ÚLTIMA
   incidencia y cuántas hay; el detalle completo se pide aparte
   (GET /incidencias_chat_center?id_cliente=).

   Una sola query batch sobre los ids ya paginados (≤20 por columna), por el
   índice idx_caso_abierto (id_cliente_chat_center, …). Si una cuenta no
   registra incidencias, no devuelve filas y la tarjeta no pinta nada.

   Las columnas de casos (tipo, escalado_resuelto, estado_caso) vienen de
   incidencias_casos_migration.sql y incidencias_casos_estado_migration.sql;
   se consultan solo si existen, igual que hace el controlador de incidencias.
   ═══════════════════════════════════════════════════════════ */
const { db } = require('../database/config');

const RECHECK_MS = 5 * 60 * 1000;
const columnasCache = {};

async function tieneColumna(columna) {
  const ahora = Date.now();
  const c = columnasCache[columna];
  if (c?.ok === true) return true;
  if (c?.ok === false && ahora - c.at < RECHECK_MS) return false;
  let ok = false;
  try {
    const rows = await db.query(
      `SHOW COLUMNS FROM incidencias_chat_center LIKE '${columna}'`,
      { type: db.QueryTypes.SELECT },
    );
    ok = rows.length > 0;
  } catch (_) {
    ok = false;
  }
  columnasCache[columna] = { ok, at: ahora };
  return ok;
}

/** Texto corto para la tarjeta: sin saltos de línea y con tope de caracteres. */
const resumir = (texto, max = 160) => {
  const plano = String(texto || '')
    .replace(/\s+/g, ' ')
    .trim();
  return plano.length > max ? `${plano.slice(0, max - 1)}…` : plano;
};

/**
 * Resumen de incidencias de un lote de contactos.
 * @returns {Map<number, {total:number, casos_abiertos:number, ultima:object}>}
 */
async function resolverIncidencias(ids = []) {
  const out = new Map();
  const limpios = [...new Set(ids.map(Number).filter(Boolean))];
  if (!limpios.length) return out;

  const conCasos = await tieneColumna('tipo');
  const conEstado = conCasos && (await tieneColumna('estado_caso'));

  // Estado del caso con la misma regla que incidencias_chat_center.controller
  const estadoExpr = !conCasos
    ? 'NULL'
    : conEstado
      ? "COALESCE(i.estado_caso, IF(i.escalado_resuelto = 1, 'resuelto', 'sin_resolver'))"
      : "IF(i.escalado_resuelto = 1, 'resuelto', 'sin_resolver')";
  const tipoExpr = conCasos ? 'i.tipo' : 'NULL';
  const abiertoExpr = conCasos
    ? 'SUM(i.tipo IS NOT NULL AND i.escalado_resuelto = 0)'
    : '0';

  let rows = [];
  try {
    rows = await db.query(
      `SELECT t.id_cliente, t.total, t.casos_abiertos,
              t.id, t.descripcion, t.autor_nombre, t.created_at, t.tipo, t.estado
         FROM (
           SELECT i.id_cliente_chat_center AS id_cliente,
                  i.id, i.descripcion, i.autor_nombre, i.created_at,
                  ${tipoExpr} AS tipo, ${estadoExpr} AS estado,
                  ROW_NUMBER() OVER (
                    PARTITION BY i.id_cliente_chat_center
                    ORDER BY i.created_at DESC, i.id DESC
                  ) AS rn,
                  COUNT(*) OVER (PARTITION BY i.id_cliente_chat_center) AS total,
                  ${abiertoExpr} OVER (PARTITION BY i.id_cliente_chat_center) AS casos_abiertos
             FROM incidencias_chat_center i
            WHERE i.id_cliente_chat_center IN (:ids)
              AND i.deleted_at IS NULL
         ) t
        WHERE t.rn = 1`,
      { replacements: { ids: limpios }, type: db.QueryTypes.SELECT },
    );
  } catch (err) {
    console.error('[incidenciasResumen] No se pudo consultar:', err.message);
    return out;
  }

  for (const r of rows) {
    out.set(Number(r.id_cliente), {
      total: Number(r.total) || 0,
      casos_abiertos: Number(r.casos_abiertos) || 0,
      ultima: {
        id: r.id,
        descripcion: resumir(r.descripcion),
        autor_nombre: r.autor_nombre,
        created_at: r.created_at,
        tipo: r.tipo || null,
        estado: r.tipo ? r.estado : null,
      },
    });
  }
  return out;
}

/** Adorna `items` (tarjetas con id) con `incidencias` o null. */
async function adornarIncidencias(items = []) {
  const mapa = await resolverIncidencias(items.map((i) => i.id));
  items.forEach((i) => {
    i.incidencias = mapa.get(Number(i.id)) || null;
  });
}

module.exports = { resolverIncidencias, adornarIncidencias };
