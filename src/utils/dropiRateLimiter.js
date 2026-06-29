'use strict';

/**
 * dropiRateLimiter.js
 *
 * Limitador GLOBAL de salidas hacia Dropi. El rate-limit de Dropi es por IP del
 * servidor (lo comparten TODOS los usuarios y todos los caminos del código:
 * cron, syncs on-demand, socket de chats, historial). Sin un limitador central,
 * el ritmo agregado supera el límite y Dropi responde 429 a cualquiera.
 *
 * Este módulo serializa/espacia TODAS las peticiones a Dropi mediante:
 *   - maxConcurrent: máximo de peticiones en vuelo a la vez.
 *   - minTime: separación mínima (ms) entre el inicio de dos peticiones.
 *
 * Se usa un limitador por país (country_code) porque cada país es una instancia
 * distinta de Dropi (baseURL distinta) con su propio límite.
 *
 * No depende de librerías externas (no hay bottleneck/p-limit instalado).
 *
 * Config vía env:
 *   DROPI_MAX_CONCURRENT (default 2)
 *   DROPI_MIN_TIME_MS    (default 400)  → ~2.5 req/s por país
 */

const MAX_CONCURRENT = Number(process.env.DROPI_MAX_CONCURRENT) || 2;
const MIN_TIME_MS = Number(process.env.DROPI_MIN_TIME_MS) || 400;

class RateLimiter {
  constructor({ maxConcurrent, minTime }) {
    this.maxConcurrent = Math.max(1, maxConcurrent);
    this.minTime = Math.max(0, minTime);
    this.active = 0;
    this.lastStart = 0;
    this.queue = [];
    this.timer = null;
  }

  /** Devuelve una promesa que resuelve cuando hay un slot disponible. */
  acquire() {
    return new Promise((resolve) => {
      this.queue.push(resolve);
      this._drain();
    });
  }

  /** Libera un slot. Debe llamarse SIEMPRE tras acquire() (éxito o error). */
  release() {
    if (this.active > 0) this.active--;
    this._drain();
  }

  _drain() {
    if (this.active >= this.maxConcurrent || this.queue.length === 0) return;

    const now = Date.now();
    const wait = this.lastStart + this.minTime - now;

    if (wait > 0) {
      if (!this.timer) {
        this.timer = setTimeout(() => {
          this.timer = null;
          this._drain();
        }, wait);
      }
      return;
    }

    const resolve = this.queue.shift();
    this.active++;
    this.lastStart = Date.now();
    resolve();

    // Intentar arrancar el siguiente respetando minTime (se auto-agenda).
    this._drain();
  }
}

const limiters = {};

function getLimiter(country_code) {
  const code = String(country_code || 'default').toUpperCase();
  if (!limiters[code]) {
    limiters[code] = new RateLimiter({
      maxConcurrent: MAX_CONCURRENT,
      minTime: MIN_TIME_MS,
    });
  }
  return limiters[code];
}

/**
 * Ejecuta `fn` (que devuelve una promesa) a través del limitador del país.
 * Garantiza liberar el slot pase lo que pase.
 */
async function scheduleDropi(country_code, fn) {
  const limiter = getLimiter(country_code);
  await limiter.acquire();
  try {
    return await fn();
  } finally {
    limiter.release();
  }
}

module.exports = { scheduleDropi, getLimiter };
