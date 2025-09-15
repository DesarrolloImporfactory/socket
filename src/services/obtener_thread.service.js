const axios = require('axios');
const { db } = require('../database/config');

/**
 * Crea un nuevo thread a través de la API de OpenAI.
 */
async function crearNuevoThread(api_key) {
  try {
    const response = await axios.post(
      'https://api.openai.com/v1/threads',
      {},
      {
        headers: {
          Authorization: `Bearer ${api_key}`,
          'Content-Type': 'application/json',
          'OpenAI-Beta': 'assistants=v2',
        },
      }
    );

    return response.data?.id || null;
  } catch (error) {
    console.error('❌ Error al crear nuevo thread:', error.message);
    return null;
  }
}

/**
 * Busca un thread existente válido o crea uno nuevo si ha expirado o no existe.
 */
async function obtenerOCrearThreadId(id_cliente_chat_center, api_key) {
  try {
    // Buscar si ya hay un thread
    const [resultado] = await db.query(
      `SELECT thread_id, fecha_creado FROM openai_threads WHERE id_cliente_chat_center = ? LIMIT 1`,
      {
        replacements: [id_cliente_chat_center],
        type: db.QueryTypes.SELECT,
      }
    );

    if (resultado) {
      const fechaCreado = new Date(resultado.fecha_creado);
      const hoy = new Date();

      const diasPasados = Math.floor(
        (hoy - fechaCreado) / (1000 * 60 * 60 * 24)
      );

      if (diasPasados < 14) {
        // Thread aún válido
        return resultado.thread_id;
      } else {
        // Expirado → eliminar
        await db.query(
          `DELETE FROM openai_threads WHERE id_cliente_chat_center = ?`,
          {
            replacements: [id_cliente_chat_center],
            type: db.QueryTypes.DELETE,
          }
        );
      }
    }

    // Crear nuevo thread
    const nuevoThreadId = await crearNuevoThread(api_key);

    if (!nuevoThreadId) {
      throw new Error('No se pudo crear un nuevo thread');
    }

    // Guardar en base de datos
    await db.query(
      `INSERT INTO openai_threads (id_cliente_chat_center, thread_id, fecha_creado)
       VALUES (?, ?, NOW())`,
      {
        replacements: [id_cliente_chat_center, nuevoThreadId],
        type: db.QueryTypes.INSERT,
      }
    );

    return nuevoThreadId;
  } catch (error) {
    console.error('❌ Error en obtenerOCrearThreadId:', error.message);
    return null;
  }
}

module.exports = {
  obtenerOCrearThreadId,
};
