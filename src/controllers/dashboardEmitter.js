// ════════════════════════════════════════════════════════════════════════
// dashboardEmitter.js — Emisor centralizado de eventos del dashboard
// ════════════════════════════════════════════════════════════════════════
const { db } = require('../database/config');
const dashboardCache = require('./dashboardCache');

const SECTIONS_BY_TIPO = {
  new_chat: ['summary', 'pendingQueue', 'charts', 'agentLoad'],
  chat_resolved: ['summary', 'slaToday', 'charts', 'agentLoad'],
  chat_transferred: ['pendingQueue', 'frequentTransfers', 'agentLoad'],
  queue_change: ['pendingQueue', 'agentLoad'],
};

const THROTTLE_MS = 3000;

class DashboardEmitter {
  constructor() {
    this.pending = new Map();
  }

  /**
   * Emitir evento por id_usuario (cuando ya lo tienes)
   */
  emit(id_usuario, tipo, deltas = null) {
    if (!id_usuario || !tipo) return;
    if (!global.presenceIo) return;

    const roomKey = `dashboard:${id_usuario}`;
    dashboardCache.invalidateUser(id_usuario);

    let entry = this.pending.get(roomKey);
    if (!entry) {
      entry = {
        tipos: new Set(),
        sections: new Set(),
        deltas: {},
        timer: null,
      };
      this.pending.set(roomKey, entry);
    }

    entry.tipos.add(tipo);
    const sections = SECTIONS_BY_TIPO[tipo] || ['summary', 'pendingQueue'];
    sections.forEach((s) => entry.sections.add(s));

    if (deltas && typeof deltas === 'object') {
      for (const [key, value] of Object.entries(deltas)) {
        if (typeof value === 'number') {
          entry.deltas[key] = (entry.deltas[key] || 0) + value;
        }
      }
    }

    if (entry.timer) return;

    entry.timer = setTimeout(() => {
      this._flush(roomKey);
    }, THROTTLE_MS);
  }

  /**
   * Emitir evento por id_configuracion (resuelve id_usuario internamente)
   * Esto evita repetir la query SELECT id_usuario en cada archivo.
   *
   * Uso:
   *   dashboardEmitter.emitByConfig(id_configuracion, 'new_chat', { chatsCreated: 1 });
   */
  async emitByConfig(id_configuracion, tipo, deltas = null) {
    if (!id_configuracion || !tipo) return;
    if (!global.presenceIo) return;

    try {
      const [cfg] = await db.query(
        `SELECT id_usuario FROM configuraciones WHERE id = ? LIMIT 1`,
        { replacements: [id_configuracion], type: db.QueryTypes.SELECT },
      );
      if (cfg?.id_usuario) {
        this.emit(cfg.id_usuario, tipo, deltas);
      }
    } catch (e) {
      console.warn('[dashboardEmitter.emitByConfig]', e.message);
    }
  }

  /**
   * Emitir inmediatamente (sin throttle)
   */
  emitNow(id_usuario, tipo, deltas = null) {
    if (!id_usuario || !tipo || !global.presenceIo) return;

    dashboardCache.invalidateUser(id_usuario);
    const sections = SECTIONS_BY_TIPO[tipo] || ['summary', 'pendingQueue'];

    global.presenceIo.to(`dashboard:${id_usuario}`).emit('dashboard:update', {
      tipos: [tipo],
      sections,
      deltas: deltas || {},
    });
  }

  _flush(roomKey) {
    const entry = this.pending.get(roomKey);
    if (!entry) return;

    clearTimeout(entry.timer);
    this.pending.delete(roomKey);

    global.presenceIo.to(roomKey).emit('dashboard:update', {
      tipos: [...entry.tipos],
      sections: [...entry.sections],
      deltas: entry.deltas,
    });
  }
}

module.exports = new DashboardEmitter();
