const presenceStore = require("./presenceStore");

module.exports = function registerPresenceHandlers(io, socket) {
  const { id_sub_usuario } = socket.user;

  // Útil: puede usar rooms por sub_usuario si después quiere “notificar a X”
  socket.join(`sub:${id_sub_usuario}`);

  // Marcar conectado al momento de conectar socket
  const stateOnConnect = presenceStore.connect(id_sub_usuario, socket.id);

  // Emitimos update global (para dashboards, listas, etc.)
  io.emit("PRESENCE_UPDATE", stateOnConnect);

  // Si el front manda register explícito (usted lo hace en usePresenceRegister)
  socket.on("PRESENCE_REGISTER", () => {
    // ya quedó registrado en connect, pero lo dejamos por consistencia
    const p = presenceStore.getPresence(id_sub_usuario);
    socket.emit("PRESENCE_UPDATE", p);
  });

  socket.on("PRESENCE_SNAPSHOT_REQUEST", () => {
    socket.emit("PRESENCE_SNAPSHOT", { presence: presenceStore.getSnapshot() });
  });

  // Si quiere pedir presencia de un usuario específico desde el front:
  socket.on("PRESENCE_GET", (payload = {}) => {
    const targetId = Number(payload.id_sub_usuario);
    if (!targetId) return;
    socket.emit("PRESENCE_UPDATE", presenceStore.getPresence(targetId));
  });

  socket.on("disconnect", () => {
    const stateOnDisconnect = presenceStore.disconnect(id_sub_usuario, socket.id);
    io.emit("PRESENCE_UPDATE", stateOnDisconnect);
  });
};
