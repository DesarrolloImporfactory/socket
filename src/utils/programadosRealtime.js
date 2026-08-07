/**
 * Room y emisión de PROGRAMADO_ESTADO (plantillas programadas por chat).
 *
 * El chat center se suscribe a `chat_programados:<id_configuracion>:<id_cliente>`
 * para saber, sin repreguntar al backend, si al contacto que tiene abierto le
 * queda alguna plantilla programada.
 *
 * Todo cambio de estado de un envío programado (enviado, error, cancelado,
 * reprogramado) debe pasar por aquí: si un camino emite por su cuenta o no
 * emite, el aviso del chat queda desactualizado y el asesor vuelve a mandar la
 * plantilla duplicada, que es justo lo que esto evita.
 */

function roomProgramados(id_configuracion, id_cliente_chat_center) {
  const idCfg = Number(id_configuracion);
  const idCli = Number(id_cliente_chat_center);

  if (!idCfg || !idCli) return null;
  return `chat_programados:${idCfg}:${idCli}`;
}

/**
 * Emite un cambio de estado al room del chat correspondiente.
 * Silencioso a propósito: es una mejora de UI, nunca debe tumbar un envío.
 *
 * @param {object} payload  Debe traer al menos id_configuracion,
 *                          id_cliente_chat_center y estado.
 * @param {object} [io]     Instancia de socket.io (por defecto global.io).
 */
function emitirProgramadoEstado(payload = {}, io = null) {
  try {
    const socketIo = io || global.io;
    if (!socketIo) return false;

    const room = roomProgramados(
      payload.id_configuracion,
      payload.id_cliente_chat_center,
    );

    if (!room) return false;

    socketIo.to(room).emit('PROGRAMADO_ESTADO', {
      ...payload,
      id_configuracion: Number(payload.id_configuracion),
      id_cliente_chat_center: Number(payload.id_cliente_chat_center),
      actualizado_en: payload.actualizado_en || new Date().toISOString(),
    });

    return true;
  } catch (e) {
    console.warn('⚠️ emitirProgramadoEstado:', e.message);
    return false;
  }
}

module.exports = { roomProgramados, emitirProgramadoEstado };
