// ════════════════════════════════════════════════════════════════════════
// dashboardCache.js — Cache en memoria con TTL para queries del dashboard
// ════════════════════════════════════════════════════════════════════════
// Problema: 10 agentes con dashboard abierto + 1 mensaje = 10 SQL idénticos
// Solución: Si la misma query se pidió hace <5s, devolver resultado cacheado
//
// Funciona así:
//   const data = await cache.getOrRun(key, ttlMs, asyncFn);
//   - Si key existe y no expiró → devuelve el valor cacheado (0 queries)
//   - Si key no existe o expiró → ejecuta asyncFn, guarda resultado, lo devuelve
//
// No necesita Redis. Es un Map en memoria del proceso Node.
// Si escalas a múltiples instancias, reemplazar por Redis con el mismo API.
// ════════════════════════════════════════════════════════════════════════

class DashboardCache {
  constructor() {
    this.store = new Map();
    // Limpiar entradas expiradas cada 30 segundos para evitar memory leaks
    this._cleanupInterval = setInterval(() => this._cleanup(), 30_000);
  }

  /**
   * Genera una key única a partir de los parámetros del dashboard
   * @param {object} params - { id_usuario, id_configuracion, agentId, from, to, section }
   * @returns {string}
   */
  buildKey({ id_usuario, id_configuracion, agentId, from, to, section }) {
    return `dash:${id_usuario}:${id_configuracion || 0}:${agentId || 0}:${from}:${to}:${section}`;
  }

  /**
   * Obtener del cache o ejecutar la función y cachear
   * @param {string} key
   * @param {number} ttlMs - Tiempo de vida en milisegundos (default 5000)
   * @param {Function} fn - Función async que genera el dato
   * @returns {Promise<any>}
   */
  async getOrRun(key, ttlMs, fn) {
    const cached = this.store.get(key);
    const now = Date.now();

    // Cache hit: devolver sin ejecutar query
    if (cached && now - cached.timestamp < ttlMs) {
      return cached.data;
    }

    // Si ya hay una promesa en vuelo para esta misma key, esperar esa
    // (evita que 10 requests simultáneas ejecuten 10 queries)
    if (cached && cached.promise) {
      try {
        return await cached.promise;
      } catch {
        // Si la promesa falló, caer al flujo normal
      }
    }

    // Cache miss: ejecutar query, guardar resultado
    const promise = fn();
    // Guardar la promesa para que requests concurrentes la esperen
    this.store.set(key, { promise, timestamp: now });

    try {
      const data = await promise;
      this.store.set(key, { data, timestamp: now, promise: null });
      return data;
    } catch (err) {
      // Si falla, limpiar para que el próximo intento re-ejecute
      this.store.delete(key);
      throw err;
    }
  }

  /**
   * Invalidar cache para un usuario (cuando llega un evento que cambia datos)
   * @param {number} id_usuario
   */
  invalidateUser(id_usuario) {
    const prefix = `dash:${id_usuario}:`;
    for (const key of this.store.keys()) {
      if (key.startsWith(prefix)) {
        this.store.delete(key);
      }
    }
  }

  /**
   * Limpiar entradas expiradas (se ejecuta periódicamente)
   */
  _cleanup() {
    const now = Date.now();
    const MAX_AGE = 60_000; // 60 segundos max de vida
    for (const [key, entry] of this.store.entries()) {
      if (now - entry.timestamp > MAX_AGE) {
        this.store.delete(key);
      }
    }
  }

  /**
   * Stats para debug/monitoreo
   */
  getStats() {
    return {
      entries: this.store.size,
      keys: [...this.store.keys()],
    };
  }

  destroy() {
    clearInterval(this._cleanupInterval);
    this.store.clear();
  }
}

// Singleton — una sola instancia para todo el proceso
module.exports = new DashboardCache();
