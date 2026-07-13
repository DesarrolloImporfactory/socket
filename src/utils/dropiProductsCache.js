'use strict';

/**
 * dropiProductsCache.js
 *
 * Caché en memoria para el listado de productos del marketplace Dropi
 * (POST /products/index). Cada vez que un cliente entra a la vista de
 * productos se disparaba una petición a Dropi; con el limitador global
 * eso significa hacer cola detrás del cron/syncs y el navegador corta
 * a los 30s. El catálogo del marketplace cambia lento, así que servirlo
 * cacheado unos minutos elimina la mayoría de esas salidas a Dropi.
 *
 * - Fresh: dentro de FRESH_MS se sirve directo del caché (sin tocar Dropi).
 * - Coalescing: peticiones idénticas simultáneas comparten UNA sola salida.
 * - Stale-if-error: si Dropi falla (429/timeout/caído) y hay una copia
 *   vieja (< STALE_MS), se sirve la copia vieja en vez de reventar.
 *
 * Config vía env:
 *   DROPI_PRODUCTS_CACHE_TTL_MS   (default 5 min)
 *   DROPI_PRODUCTS_CACHE_STALE_MS (default 30 min)
 */

const FRESH_MS =
  Number(process.env.DROPI_PRODUCTS_CACHE_TTL_MS) || 5 * 60 * 1000;
const STALE_MS =
  Number(process.env.DROPI_PRODUCTS_CACHE_STALE_MS) || 30 * 60 * 1000;
const MAX_ENTRIES = 300;

const cache = new Map(); // key -> { data, at }
const inflight = new Map(); // key -> Promise<data>

function setEntry(key, data) {
  // Evicción simple: Map mantiene orden de inserción → borrar el más viejo.
  if (cache.size >= MAX_ENTRIES && !cache.has(key)) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.delete(key); // re-insertar para refrescar el orden
  cache.set(key, { data, at: Date.now() });
}

/**
 * Devuelve { data, source } donde source ∈ 'cache' | 'dropi' | 'stale'.
 * `fetcher` es la función que realmente sale a Dropi (devuelve promesa).
 */
async function getProductosConCache(key, fetcher) {
  const hit = cache.get(key);
  const now = Date.now();

  if (hit && now - hit.at < FRESH_MS) {
    return { data: hit.data, source: 'cache' };
  }

  // Si ya hay una petición idéntica en vuelo, colgarse de esa
  if (inflight.has(key)) {
    const data = await inflight.get(key);
    return { data, source: 'dropi' };
  }

  const p = fetcher()
    .then((data) => {
      // No cachear respuestas que Dropi marque como fallidas
      if (data && data.isSuccess !== false) setEntry(key, data);
      return data;
    })
    .finally(() => inflight.delete(key));

  inflight.set(key, p);

  try {
    const data = await p;
    return { data, source: 'dropi' };
  } catch (err) {
    // Dropi falló: servir copia vieja si todavía es utilizable
    if (hit && now - hit.at < STALE_MS) {
      console.log(
        `[dropiProductsCache] Dropi falló (${err?.message}); sirviendo copia stale de ${Math.round((now - hit.at) / 1000)}s`,
      );
      return { data: hit.data, source: 'stale' };
    }
    throw err;
  }
}

module.exports = { getProductosConCache };
