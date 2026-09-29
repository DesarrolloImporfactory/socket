/**
 * Conteo de casos de Incidencias para el dashboard de atención (pedido
 * «gestión de incidencias», parte 4 — 2026-09-29).
 *
 * Un CASO es una incidencia marcada como «Escalar» u «Oportunidad Comercial»
 * desde el panel del chat (incidencias_chat_center.controller.js). Aquí:
 *   - escalados: casos de tipo escalamiento creados en el rango;
 *   - respondidos: de esos, los que ya tuvieron respuesta de quien los
 *     recibe (se pusieron en espera o se resolvieron). Un caso «sin resolver»
 *     todavía no tiene respuesta.
 * Lo mismo para oportunidades, que el tablero muestra aparte.
 *
 * Sin las migraciones de casos (tabla sin columna `tipo`) o sin conexiones
 * con destinatarios configurados, devuelve { habilitado: false } y el
 * tablero no pinta la tarjeta.
 */
const { db } = require('../database/config');

const TIPOS = ['escalamiento', 'oportunidad'];

async function tieneColumnas() {
  try {
    const rows = await db.query(
      "SHOW COLUMNS FROM incidencias_chat_center LIKE 'escalado_resuelto'",
      { type: db.QueryTypes.SELECT },
    );
    if (!rows.length) return { casos: false, estado: false };
    const est = await db.query(
      "SHOW COLUMNS FROM incidencias_chat_center LIKE 'estado_caso'",
      { type: db.QueryTypes.SELECT },
    );
    return { casos: true, estado: est.length > 0 };
  } catch (_) {
    return { casos: false, estado: false };
  }
}

async function buildCasosIncidencias(configIds, fromDT, toDT) {
  const vacio = { habilitado: false };
  if (!configIds?.length) return vacio;
  const cols = await tieneColumnas();
  if (!cols.casos) return vacio;

  const configurados = await db.query(
    `SELECT DISTINCT id_configuracion FROM incidencias_casos_destinatarios
      WHERE id_configuracion IN (?)`,
    { replacements: [configIds], type: db.QueryTypes.SELECT },
  );
  if (!configurados.length) return vacio;

  const estado = cols.estado
    ? "COALESCE(estado_caso, IF(escalado_resuelto = 1, 'resuelto', 'sin_resolver'))"
    : "IF(escalado_resuelto = 1, 'resuelto', 'sin_resolver')";

  const filas = await db.query(
    `SELECT tipo, ${estado} AS estado, COUNT(*) AS n
       FROM incidencias_chat_center
      WHERE deleted_at IS NULL AND tipo IS NOT NULL
        AND id_configuracion IN (?)
        AND created_at BETWEEN ? AND ?
      GROUP BY tipo, estado`,
    { replacements: [configIds, fromDT, toDT], type: db.QueryTypes.SELECT },
  );

  const res = { habilitado: true };
  for (const t of TIPOS) {
    res[t] = { total: 0, respondidos: 0, sin_resolver: 0, en_espera: 0, resuelto: 0 };
  }
  for (const f of filas) {
    const c = res[f.tipo];
    if (!c) continue;
    const n = Number(f.n);
    c.total += n;
    c[f.estado] = (c[f.estado] || 0) + n;
    if (f.estado !== 'sin_resolver') c.respondidos += n;
  }
  return res;
}

module.exports = { buildCasosIncidencias };
