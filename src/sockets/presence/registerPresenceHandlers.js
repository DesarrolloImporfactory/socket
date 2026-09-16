const presenceStore = require('./presenceStore');
const presenceSessions = require('./presenceSessions');

presenceSessions.iniciarTouch();

module.exports = function registerPresenceHandlers(io, socket) {
  const { id_sub_usuario, id_usuario } = socket.user;

  // Útil: puede usar rooms por sub_usuario si después quiere “notificar a X”
  socket.join(`sub:${id_sub_usuario}`);

  // Marcar conectado al momento de conectar socket
  const stateOnConnect = presenceStore.connect(id_sub_usuario, socket.id);

  // Historial en BD: solo cuando pasa de offline a online (primer socket).
  if (stateOnConnect.socket_count === 1) {
    presenceSessions.abrir(id_sub_usuario, id_usuario);
  }

  // Emitimos update global (para dashboards, listas, etc.)
  io.emit('PRESENCE_UPDATE', stateOnConnect);

  // Si el front manda register explícito (usted lo hace en usePresenceRegister)
  socket.on('PRESENCE_REGISTER', () => {
    // ya quedó registrado en connect, pero lo dejamos por consistencia
    const p = presenceStore.getPresence(id_sub_usuario);
    socket.emit('PRESENCE_UPDATE', p);
  });

  socket.on('PRESENCE_SNAPSHOT_REQUEST', () => {
    socket.emit('PRESENCE_SNAPSHOT', { presence: presenceStore.getSnapshot() });
  });

  // Si quiere pedir presencia de un usuario específico desde el front:
  socket.on('PRESENCE_GET', (payload = {}) => {
    const targetId = Number(payload.id_sub_usuario);
    if (!targetId) return;
    socket.emit('PRESENCE_UPDATE', presenceStore.getPresence(targetId));
  });

  socket.on('dashboard:join', ({ id_usuario }) => {
    if (!id_usuario) return;
    socket.join(`dashboard:${id_usuario}`);
  });

  socket.on('dashboard:leave', ({ id_usuario }) => {
    socket.leave(`dashboard:${id_usuario}`);
  });

  socket.on('disconnect', () => {
    const stateOnDisconnect = presenceStore.disconnect(
      id_sub_usuario,
      socket.id,
    );
    if (!stateOnDisconnect.online) presenceSessions.cerrar(id_sub_usuario);
    io.emit('PRESENCE_UPDATE', stateOnDisconnect);
  });
};
