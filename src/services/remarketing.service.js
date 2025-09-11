const { db } = require('../database/config');

async function cancelRemarketing({ telefono, id_configuracion }) {
  // si quieres limitar por id_configuracion:
  const result = await db.query(
    `UPDATE remarketing_pendientes 
     SET cancelado = 1 
     WHERE telefono = ? 
       AND enviado = 0 
       AND cancelado = 0
       AND id_configuracion = ?`,
    {
      replacements: [telefono, id_configuracion],
      type: db.QueryTypes.UPDATE,
    }
  );
  return result; // filas afectadas
}

async function cancelRemarketingWithResponse({ telefono, id_configuracion }) {
  try {
    const result = await db.query(
      `UPDATE remarketing_pendientes 
       SET cancelado = 1 
       WHERE telefono = ? 
         AND enviado = 0 
         AND cancelado = 0
         AND id_configuracion = ?`,
      {
        replacements: [telefono, id_configuracion],
        type: db.QueryTypes.UPDATE,
      }
    );

    const affected = Array.isArray(result) ? result[0] : result;

    return {
      status: 200,
      success: true,
      affected,
      message: affected > 0
        ? `Se cancelaron ${affected} registros de remarketing`
        : 'No había registros para cancelar',
    };
  } catch (error) {
    return {
      status: 500,
      success: false,
      message: 'Error al cancelar remarketing',
      error: error.message,
    };
  }
}

async function cancelRemarketingByThread({ id_thread }) {
  const result = await db.query(
    `UPDATE remarketing_pendientes 
     SET cancelado = 1 
     WHERE id_thread = ? 
       AND enviado = 0 
       AND cancelado = 0`,
    {
      replacements: [id_thread],
      type: db.QueryTypes.UPDATE,
    }
  );
  return result;
}

module.exports = {
  cancelRemarketing,
  cancelRemarketingWithResponse,
  cancelRemarketingByThread,
};
