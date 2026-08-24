'use strict';

/**
 * Lugar de retiro cuando una orden Dropi termina en RETIRO EN AGENCIA.
 *
 * ── Por qué existe ─────────────────────────────────────────────────────────
 * Dropi NO manda en qué agencia quedó el paquete. Cuando Servientrega no
 * entrega a domicilio (zona de riesgo, sin cobertura, cliente pide CS…) y lo
 * deja en una agencia, el webhook y el detalle de la orden siguen trayendo en
 * `dir` el DOMICILIO del cliente, y `servientrega_movements` trae el
 * movimiento "INGRESANDO EN AGENCIA" sin decir cuál. Medido 60 días
 * (2026-08-21): 4.779 órdenes en agencia, ~1.650 (35%) con un domicilio en
 * `dir`. Caso que lo motivó: cfg 889, orden 6612199 / guía 189396584 — la
 * plantilla de retiro le dijo al cliente que retire en su propia casa.
 *
 * ── Qué hace ───────────────────────────────────────────────────────────────
 *  1. pareceAgencia(dir): decide si el texto que el vendedor puso en `dir` es
 *     una agencia o un domicilio. Sobre 4.721 órdenes en agencia: 4.094 tienen
 *     agencia escrita (87%) y 627 son domicilios desviados por la
 *     transportadora. Se revisó la muestra a mano; las palabras vienen de ahí.
 *  2. consultarAgenciaServientrega(guia): lee la página pública de tracking
 *     de Servientrega EC (la misma que se le manda al cliente en {{tracking}})
 *     y saca el movimiento "Ingresando en Agencia CIUDAD_NOMBRE" + el motivo
 *     del desvío. Probado con 20 guías desviadas: 20/20 traían la agencia.
 *     Es scraping de HTML público, no una API: si cambian el markup deja de
 *     encontrar la agencia y se CAE AL FALLBACK (no a nada). Bajo carga
 *     responde en 3–19 s, por eso el timeout es generoso y nunca va inline en
 *     el handler del webhook (el processor ya trabaja en cola).
 *  3. resolverLugarRetiro(order): junta las dos —
 *       agencia real (Servientrega) > `dir` si parece agencia > "agencia
 *       Servientrega en {ciudad}" — y persiste la agencia en
 *       dropi_orders_cache.agencia_retiro (si la columna existe; ver
 *       agencia_retiro_migration.sql) para que recordatorios, bot y vista de
 *       pedidos la reutilicen sin volver a consultar.
 *
 * Una consulta por orden, en el momento en que Dropi avisa el estado (no hay
 * polling: ~80 órdenes/día llegan a agencia). Caché en memoria por guía para
 * que dropshipper + proveedor de la misma orden no consulten dos veces.
 */

const axios = require('axios');
const { db } = require('../database/config');

const TRACKING_URL = 'https://www.servientrega.com.ec/Tracking/';
// Medido: una sola consulta tarda 2–15 s; bajo carga hasta 19 s.
const TIMEOUT_MS_DEFAULT = 25000;
const CACHE_TTL_OK_MS = 12 * 60 * 60 * 1000; // 12 h: la agencia no cambia
const CACHE_TTL_NEG_MS = 30 * 60 * 1000; // 30 min: el movimiento puede tardar
const CACHE_MAX = 3000;

/* ═══════════════════════════════════════════════════════════
   1. ¿Lo que el vendedor escribió en `dir` es una agencia?
   ═══════════════════════════════════════════════════════════ */

// "ientrega" atrapa las variantes reales: servientrega, Serbientrega,
// Cebientrega, "ervientrega" (faltó la S). "entrega" a secas NO matchea.
const RE_AGENCIA_FUERTE =
  /agenc|oficin|ientrega|centro\s+de\s+soluci|\bc\.?\s?s\.?\b|retir[aoe]|sucursal/i;
// Código CS de Servientrega tal cual sale en su reporte: "CIUDAD_NOMBRE"
// ("DURAN_AV. NICOLAS LAPENTTI", "QUITO_LA COLON", "MACAS_CENTRAL").
const RE_CODIGO_CS = /^[A-ZÁÉÍÓÚÑ][A-ZÁÉÍÓÚÑ0-9 .()\-]{1,40}_\s*\S/;
// El vendedor marcó explícitamente que va a la casa. "a la casa" a secas NO
// entra: "Servientrega Quevedo… FRENTE A LA CASA JUDICIAL" es una agencia.
const RE_DOMICILIO = /\bdomicilio\b|\ben\s+(?:mi|su)\s+casa\b/i;

function pareceAgencia(dir) {
  const s = String(dir || '').trim();
  if (!s) return false;
  const fuerte = RE_AGENCIA_FUERTE.test(s) || RE_CODIGO_CS.test(s);
  if (!fuerte) return false;
  // "(A DOMICILIO) ... frente a Servientrega": la agencia es referencia.
  // Gana el domicilio salvo que además diga retiro/agencia/oficina/CS.
  if (RE_DOMICILIO.test(s) && !/agenc|oficin|retir[aoe]|\bcs\b/i.test(s)) {
    return false;
  }
  return true;
}

/* ═══════════════════════════════════════════════════════════
   2. Tracking público de Servientrega EC
   ═══════════════════════════════════════════════════════════ */

const cache = new Map(); // guia → { value, exp }

function cacheGet(guia) {
  const hit = cache.get(guia);
  if (!hit) return undefined;
  if (hit.exp < Date.now()) {
    cache.delete(guia);
    return undefined;
  }
  return hit.value;
}

function cacheSet(guia, value, ttl) {
  if (cache.size >= CACHE_MAX) {
    // FIFO simple: borra la más vieja.
    const first = cache.keys().next().value;
    if (first !== undefined) cache.delete(first);
  }
  cache.set(guia, { value, exp: Date.now() + ttl });
}

function decodeEntities(s) {
  return String(s || '')
    .replace(/&amp;/g, '&')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function esServientregaEcuador(order, country_code) {
  const comp = String(order?.shipping_company || '').toUpperCase();
  if (!comp.includes('SERVIENTREGA')) return false;
  const cc = String(country_code || '').toUpperCase();
  const pais = String(order?.country || '').toUpperCase();
  if (cc && cc !== 'EC') return false;
  if (pais && !pais.startsWith('EC')) return false;
  return true;
}

/**
 * Parsea el HTML del tracking. Exportado para poder probarlo sin red.
 * @returns {{agencia:string|null, motivo:string|null, fechaAgencia:string|null,
 *            estadoActual:string|null, movimientos:Array<{fecha,texto}>}}
 */
function parsearTrackingServientrega(html) {
  const h = String(html || '');
  const movimientos = [];
  const re = /<p>\s*(\d{4}-\d{2}-\d{2} \d{2}:\d{2})\s*<\/p>\s*<p>([^<]*)<\/p>/g;
  let m;
  while ((m = re.exec(h))) {
    movimientos.push({ fecha: m[1], texto: decodeEntities(m[2]) });
  }
  // La página lista del más reciente al más viejo.
  let agencia = null;
  let fechaAgencia = null;
  let motivo = null;
  for (const mov of movimientos) {
    if (!agencia) {
      const a = mov.texto.match(/ingresando en agencia\s+(.+)$/i);
      if (a) {
        agencia = a[1].trim();
        fechaAgencia = mov.fecha;
      }
    }
    if (!motivo) {
      const d = mov.texto.match(
        /^(?:devoluci[oó]n de distribuci[oó]n|novedad en cs)\s*(.*)$/i,
      );
      if (d && d[1]) motivo = d[1].trim();
      else if (/zona de alto riesgo|sin cobertura/i.test(mov.texto))
        motivo = mov.texto;
    }
  }
  // Aún no ingresó, pero ya va en ruta a una concesión (agencia) concreta.
  if (!agencia) {
    for (const mov of movimientos) {
      const r = mov.texto.match(/en ruta a concesion\s+(.+)$/i);
      if (r) {
        agencia = r[1].trim();
        fechaAgencia = mov.fecha;
        break;
      }
    }
  }
  const e = h.match(/Estado actual:\s*<span>\s*([^<]+)</i);
  return {
    agencia: agencia || null,
    motivo: motivo || null,
    fechaAgencia,
    estadoActual: e ? decodeEntities(e[1]) : null,
    movimientos,
  };
}

/**
 * Consulta el tracking por guía. Devuelve null si no hay agencia todavía o
 * si la página no respondió. Nunca lanza.
 */
async function consultarAgenciaServientrega(
  guia,
  { timeoutMs = TIMEOUT_MS_DEFAULT } = {},
) {
  const g = String(guia || '').trim();
  if (!/^\d{6,15}$/.test(g)) return null;

  const hit = cacheGet(g);
  if (hit !== undefined) return hit;

  try {
    const { data } = await axios.get(TRACKING_URL, {
      params: { guia: g, tipo: 'GUIA' },
      timeout: timeoutMs,
      responseType: 'text',
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ChatCenter/1.0)' },
    });
    const r = parsearTrackingServientrega(data);
    if (!r.agencia) {
      if (!r.movimientos.length) {
        // Cambiaron el markup o la guía no existe: se avisa para enterarnos.
        console.log(
          `[retiro-agencia] tracking guía ${g}: 0 movimientos parseados (¿cambió la página?)`,
        );
      }
      cacheSet(g, null, CACHE_TTL_NEG_MS);
      return null;
    }
    const value = {
      agencia: r.agencia,
      motivo: r.motivo,
      fechaAgencia: r.fechaAgencia,
      estadoActual: r.estadoActual,
    };
    cacheSet(g, value, CACHE_TTL_OK_MS);
    return value;
  } catch (e) {
    console.log(
      `[retiro-agencia] tracking guía ${g} falló: ${e?.code || ''} ${e?.message || e}`,
    );
    // No se cachea el error de red: el siguiente interesado reintenta.
    return null;
  }
}

/* ═══════════════════════════════════════════════════════════
   Persistencia en dropi_orders_cache (tolerante a columna ausente)
   ═══════════════════════════════════════════════════════════ */

let columnasDisponibles = true; // se apaga si la BD dice que no existen

async function leerAgenciaCache(dropi_order_id) {
  if (!columnasDisponibles || !dropi_order_id) return null;
  try {
    const [row] = await db.query(
      `SELECT agencia_retiro, agencia_motivo
         FROM dropi_orders_cache
        WHERE dropi_order_id = ? AND agencia_retiro IS NOT NULL
        LIMIT 1`,
      { replacements: [dropi_order_id], type: db.QueryTypes.SELECT },
    );
    if (!row) return null;
    return { agencia: row.agencia_retiro, motivo: row.agencia_motivo || null };
  } catch (e) {
    if (/Unknown column/i.test(e?.message || '')) {
      columnasDisponibles = false;
      console.log(
        '[retiro-agencia] dropi_orders_cache sin columnas agencia_retiro/agencia_motivo — correr agencia_retiro_migration.sql. Mientras, se consulta sin persistir.',
      );
    }
    return null;
  }
}

async function guardarAgenciaCache(dropi_order_id, { agencia, motivo }) {
  if (!columnasDisponibles || !dropi_order_id || !agencia) return;
  try {
    await db.query(
      `UPDATE dropi_orders_cache
          SET agencia_retiro = ?, agencia_motivo = ?, agencia_at = NOW()
        WHERE dropi_order_id = ?`,
      {
        replacements: [
          String(agencia).slice(0, 200),
          motivo ? String(motivo).slice(0, 200) : null,
          dropi_order_id,
        ],
        type: db.QueryTypes.UPDATE,
      },
    );
  } catch (e) {
    if (/Unknown column/i.test(e?.message || '')) columnasDisponibles = false;
  }
}

/* ═══════════════════════════════════════════════════════════
   3. Resolver el lugar de retiro para una orden
   ═══════════════════════════════════════════════════════════ */

/** "DURAN_AV. NICOLAS LAPENTTI" → "Agencia Servientrega DURAN - AV. NICOLAS LAPENTTI" */
function formatearAgencia(codigoCS) {
  const s = String(codigoCS || '').trim();
  if (!s) return '';
  const i = s.indexOf('_');
  if (i > 0) {
    const ciudad = s.slice(0, i).trim();
    const nombre = s.slice(i + 1).trim();
    return `Agencia Servientrega ${ciudad} - ${nombre}`;
  }
  return `Agencia Servientrega ${s}`;
}

function lugarFallback(order) {
  const dir = String(order?.dir || '').trim();
  if (pareceAgencia(dir)) return { lugar: dir, fuente: 'dir' };
  const ciudad = String(order?.city || '').trim();
  const comp = String(order?.shipping_company || '').trim();
  const transportadora = /servientrega/i.test(comp)
    ? 'Servientrega'
    : comp || 'la transportadora';
  return {
    lugar: ciudad
      ? `agencia de ${transportadora} en ${ciudad}`
      : `agencia de ${transportadora}`,
    fuente: ciudad ? 'ciudad' : 'transportadora',
  };
}

/**
 * @param {object} p
 * @param {object} p.order        orden normalizada (dir, city, shipping_guide, shipping_company, id)
 * @param {string} [p.country_code]
 * @param {boolean} [p.consultar=true]  false = solo caché/BD/heurística (sin red)
 * @param {number}  [p.timeoutMs]
 * @returns {Promise<{lugar:string, agencia:string|null, motivo:string|null, fuente:string}>}
 *   fuente: 'servientrega' | 'cache' | 'dir' | 'ciudad' | 'transportadora'
 */
async function resolverLugarRetiro({
  order,
  country_code,
  consultar = true,
  timeoutMs = TIMEOUT_MS_DEFAULT,
} = {}) {
  const dropiOrderId = Number(order?.id || 0) || null;

  // a) ¿ya la tenemos guardada?
  const guardada = await leerAgenciaCache(dropiOrderId);
  if (guardada?.agencia) {
    return {
      lugar: formatearAgencia(guardada.agencia),
      agencia: guardada.agencia,
      motivo: guardada.motivo,
      fuente: 'cache',
    };
  }

  // b) preguntarle a Servientrega
  if (consultar && esServientregaEcuador(order, country_code)) {
    const r = await consultarAgenciaServientrega(order.shipping_guide, {
      timeoutMs,
    });
    if (r?.agencia) {
      await guardarAgenciaCache(dropiOrderId, r);
      return {
        lugar: formatearAgencia(r.agencia),
        agencia: r.agencia,
        motivo: r.motivo,
        fuente: 'servientrega',
      };
    }
  }

  // c) lo de siempre, pero sin mandar el domicilio como lugar de retiro
  const fb = lugarFallback(order);
  return { lugar: fb.lugar, agencia: null, motivo: null, fuente: fb.fuente };
}

/**
 * Completa la agencia en segundo plano (para el bot / la vista) sin frenar a
 * quien llama. Best-effort, nunca lanza.
 */
function completarAgenciaEnBackground({ order, country_code }) {
  if (!esServientregaEcuador(order, country_code)) return;
  resolverLugarRetiro({ order, country_code, consultar: true }).catch(() => {});
}

module.exports = {
  pareceAgencia,
  parsearTrackingServientrega,
  consultarAgenciaServientrega,
  resolverLugarRetiro,
  completarAgenciaEnBackground,
  formatearAgencia,
  esServientregaEcuador,
};
