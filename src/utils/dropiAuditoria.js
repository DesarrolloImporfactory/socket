'use strict';
/**
 * utils/dropiAuditoria.js
 *
 * Auditoría de lo que el chat le pide a Dropi desde el server (cotizar
 * transportadoras, crear orden). Las peticiones solo salen de producción, así
 * que sin esto no había forma de analizar desde afuera por qué a un cliente
 * "se le queda cargando" o "no le salen transportadoras": el panel ya solo
 * muestra el mensaje genérico de interferencias (decisión de Daniel,
 * 05-11-2026) y el motivo real queda ACÁ, con el payload resumido, el tiempo
 * que tardó y lo que Dropi contestó.
 *
 * Tabla `dropi_auditoria_acciones` (ver dropi_auditoria_migration.sql). Se
 * crea sola la primera vez si no existe (CREATE TABLE IF NOT EXISTS, igual
 * que las tablas de la agenda pública), para no depender del .sql a mano.
 * Todo es best-effort: un fallo de la auditoría nunca rompe la acción.
 *
 * Lectura: node scripts/auditoriaDropi.js --cfg 569 --dias 7
 */
const { db } = require('../database/config');

const SQL_CREAR = `
CREATE TABLE IF NOT EXISTS dropi_auditoria_acciones (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  id_configuracion BIGINT UNSIGNED NULL,
  accion VARCHAR(40) NOT NULL,
  country_code VARCHAR(4) NULL,
  resultado VARCHAR(30) NOT NULL,
  motivo VARCHAR(600) NULL,
  detalle LONGTEXT NULL,
  ms INT UNSIGNED NULL,
  socket_id VARCHAR(64) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_cfg_fecha (id_configuracion, created_at),
  KEY idx_accion_resultado (accion, resultado, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`;

let tablaLista = null; // Promise: se asegura una sola vez por proceso

function asegurarTabla() {
  if (!tablaLista) {
    tablaLista = db.query(SQL_CREAR).catch((e) => {
      console.error('[dropiAuditoria] no se pudo crear la tabla:', e?.message);
      tablaLista = null; // que lo vuelva a intentar la próxima
      throw e;
    });
  }
  return tablaLista;
}

const recortar = (v, n) => {
  if (v == null) return null;
  const s = String(v);
  return s.length > n ? s.slice(0, n) : s;
};

function serializarDetalle(detalle) {
  if (detalle == null) return null;
  try {
    const s = typeof detalle === 'string' ? detalle : JSON.stringify(detalle);
    // LONGTEXT aguanta, pero una respuesta entera de Dropi con 10 transportadoras
    // pesa decenas de KB y no aporta: se guarda el principio.
    return s.length > 20000 ? s.slice(0, 20000) + '…' : s;
  } catch (_) {
    return null;
  }
}

/**
 * Registra una acción. No devuelve nada útil y nunca lanza.
 * @param {object} p
 * @param {number|null} p.id_configuracion
 * @param {'cotizar'|'crear_orden'|string} p.accion
 * @param {string|null} p.country_code
 * @param {'ok'|'sin_transportadoras'|'dropi_no_cotizo'|'error_dropi'|'error'|string} p.resultado
 * @param {string|null} p.motivo        texto corto (el mensaje real de Dropi o del error)
 * @param {object|string|null} p.detalle payload resumido + respuesta
 * @param {number|null} p.ms            duración total de la acción
 * @param {string|null} p.socket_id
 */
function registrarAuditoriaDropi(p = {}) {
  const fila = {
    id_configuracion: Number(p.id_configuracion) || null,
    accion: recortar(p.accion || 'desconocida', 40),
    country_code: recortar(p.country_code, 4),
    resultado: recortar(p.resultado || 'desconocido', 30),
    motivo: recortar(p.motivo, 600),
    detalle: serializarDetalle(p.detalle),
    ms: Number.isFinite(Number(p.ms)) ? Math.round(Number(p.ms)) : null,
    socket_id: recortar(p.socket_id, 64),
  };
  // Fuera del camino crítico: no se espera.
  asegurarTabla()
    .then(() =>
      db.query(
        `INSERT INTO dropi_auditoria_acciones
           (id_configuracion, accion, country_code, resultado, motivo, detalle, ms, socket_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        {
          replacements: [
            fila.id_configuracion,
            fila.accion,
            fila.country_code,
            fila.resultado,
            fila.motivo,
            fila.detalle,
            fila.ms,
            fila.socket_id,
          ],
          type: db.QueryTypes.INSERT,
        },
      ),
    )
    .catch((e) => {
      console.error('[dropiAuditoria] no se pudo registrar:', e?.message);
    });
}

/* Resumen del payload de una cotización: lo que hace falta para reproducirla
   sin guardar el objeto entero. */
function resumirPayloadCotizacion(payload = {}) {
  const productos = Array.isArray(payload.products) ? payload.products : [];
  return {
    EnvioConCobro: payload.EnvioConCobro,
    ciudad_destino_cod_dane: payload.ciudad_destino_cod_dane || null,
    ciudad_destino: payload.ciudad_destino_full?.name || null,
    ciudad_destino_id: payload.ciudad_destino_full?.id || null,
    ciudad_remitente_cod_dane: payload.ciudad_remitente_cod_dane || null,
    warehouse_city_id: payload.warehouse_city_id || null,
    zip_code: payload.zip_code || null,
    amount: payload.amount ?? null,
    productos: productos.map((p) => ({
      id: p.id,
      quantity: p.quantity,
      type: p.type,
    })),
  };
}

module.exports = { registrarAuditoriaDropi, resumirPayloadCotizacion };
