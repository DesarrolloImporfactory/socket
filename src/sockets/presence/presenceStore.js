function nowIso() {
  return new Date().toISOString();
}

/**
 * presenceBySubUser:
 * {
 *   [id_sub_usuario]: {
 *     online: boolean,
 *     connected_at: string|null,
 *     disconnected_at: string|null,
 *     last_seen: string|null,
 *     socket_count: number
 *   }
 * }
 *
 * socketsBySubUser:
 * {
 *   [id_sub_usuario]: Set(socketId)
 * }
 */
class PresenceStore {
  constructor() {
    this.presenceBySubUser = {};
    this.socketsBySubUser = new Map();
  }

  _ensure(id) {
    if (!this.presenceBySubUser[id]) {
      this.presenceBySubUser[id] = {
        online: false,
        connected_at: null,
        disconnected_at: null,
        last_seen: null,
        socket_count: 0,
      };
    }
    if (!this.socketsBySubUser.has(id)) {
      this.socketsBySubUser.set(id, new Set());
    }
  }

  connect(id_sub_usuario, socketId) {
    const id = Number(id_sub_usuario);
    this._ensure(id);

    const set = this.socketsBySubUser.get(id);
    set.add(socketId);

    const p = this.presenceBySubUser[id];
    const wasOnline = p.online;

    p.socket_count = set.size;
    p.online = true;

    // Si estaba offline y pasa a online, marcamos connected_at
    if (!wasOnline) {
      p.connected_at = nowIso();
      p.disconnected_at = null;
      p.last_seen = null;
    }

    return { id_sub_usuario: id, ...p };
  }

  disconnect(id_sub_usuario, socketId) {
    const id = Number(id_sub_usuario);
    this._ensure(id);

    const set = this.socketsBySubUser.get(id);
    set.delete(socketId);

    const p = this.presenceBySubUser[id];

    p.socket_count = set.size;

    // Solo se marca offline si ya no queda ningún socket
    if (set.size === 0) {
      p.online = false;
      p.disconnected_at = nowIso();
      p.last_seen = p.disconnected_at;
      // p.connected_at se deja como historial de la última conexión
    }

    return { id_sub_usuario: id, ...p };
  }

  getSnapshot() {
    return this.presenceBySubUser;
  }

  getPresence(id_sub_usuario) {
    const id = Number(id_sub_usuario);
    this._ensure(id);
    return { id_sub_usuario: id, ...this.presenceBySubUser[id] };
  }
}

module.exports = new PresenceStore();
