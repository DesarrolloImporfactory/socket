// services/obtener_response.service.js
// Reemplaza obtener_thread.service.js para la Responses API.
// En lugar de thread_id, guardamos el response_id del último mensaje
// por cliente. OpenAI mantiene el historial en su lado con store: true.

const { db } = require('../database/config');

/**
 * Obtiene el response_id del último mensaje del cliente.
 * Retorna null si es el primer mensaje (se enviará sin previous_response_id).
 */
async function obtenerUltimoResponseId(id_cliente_chat_center) {
  const [resultado] = await db.query(
    `SELECT response_id, fecha_creado FROM openai_threads 
     WHERE id_cliente_chat_center = ? LIMIT 1`,
    { replacements: [id_cliente_chat_center], type: db.QueryTypes.SELECT },
  );

  if (!resultado?.response_id) return null;

  // Reiniciar si pasaron más de 14 días
  const diasPasados = Math.floor(
    (Date.now() - new Date(resultado.fecha_creado).getTime()) /
      (1000 * 60 * 60 * 24),
  );

  if (diasPasados >= 14) {
    await db.query(
      `UPDATE openai_threads SET response_id = NULL WHERE id_cliente_chat_center = ?`,
      { replacements: [id_cliente_chat_center], type: db.QueryTypes.UPDATE },
    );
    return null; // arranca conversación nueva
  }

  return resultado.response_id;
}

/**
 * Guarda o actualiza el response_id del último mensaje del cliente.
 * Se llama después de cada respuesta exitosa del asistente.
 */
async function guardarResponseId(id_cliente_chat_center, response_id) {
  try {
    await db.query(
      `INSERT INTO openai_threads (id_cliente_chat_center, response_id, fecha_creado)
       VALUES (?, ?, NOW())
       ON DUPLICATE KEY UPDATE 
         response_id = VALUES(response_id),
         fecha_creado = NOW()`,
      {
        replacements: [id_cliente_chat_center, response_id],
        type: db.QueryTypes.INSERT,
      },
    );
  } catch (error) {
    console.error('❌ Error al guardar response_id:', error.message);
  }
}

module.exports = {
  obtenerUltimoResponseId,
  guardarResponseId,
};
