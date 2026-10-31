/**
 * Resincroniza los recordatorios YA agendados de una columna con la
 * configuración de remarketing recién guardada.
 *
 * Cada fila de remarketing_pendientes lleva una COPIA de la configuración
 * (plantilla, método dentro de 24 h, prompt de IA, respuesta rápida, destino)
 * tomada en el momento de agendarse, y el cron manda lo que dice la fila. Por
 * eso, cuando la tienda cambia la secuencia, durante horas siguen saliendo
 * los mensajes anteriores: Express Store (1549, 31-10-2026) pasó de 3 pasos
 * con IA a 1 paso con respuesta rápida y sus clientes seguían recibiendo «Tu
 * pedido está empacado y listo para salir» del prompt viejo.
 *
 * Regla: para cada pendiente sin enviar de esa columna (los del remarketing
 * por producto no se tocan, su contenido vive en remarketing_producto):
 *  - si la secuencia nueva tiene un paso con la misma posición, se le copia
 *    ese paso y conserva su hora de disparo (el cliente sigue en su turno);
 *  - si ya no existe esa posición (la secuencia se acortó), se cancela.
 * Los parámetros de plantilla se conservan: el cron los cuadra contra la
 * plantilla real antes de enviar.
 *
 * @returns {Promise<{actualizados:number, cancelados:number}>}
 */
const { db } = require('../database/config');

async function resincronizarPendientesRemarketing(
  id_configuracion,
  estado_contacto,
) {
  const nuevos = await db.query(
    `SELECT secuencia, nombre_template, language_code, estado_destino,
            header_format, header_media_url, header_media_name, header_parameters,
            id_template_rapido, usar_respuesta_rapida, metodo_dentro_24h, prompt_ia
       FROM configuracion_remarketing
      WHERE id_configuracion = ? AND estado_contacto = ? AND activo = 1`,
    {
      replacements: [id_configuracion, estado_contacto],
      type: db.QueryTypes.SELECT,
    },
  );
  const porSecuencia = new Map(nuevos.map((c) => [Number(c.secuencia || 1), c]));

  const pendientes = await db.query(
    `SELECT id, secuencia FROM remarketing_pendientes
      WHERE id_configuracion = ? AND estado_contacto_origen = ?
        AND enviado = 0 AND cancelado = 0 AND id_remarketing_producto IS NULL`,
    {
      replacements: [id_configuracion, estado_contacto],
      type: db.QueryTypes.SELECT,
    },
  );

  let actualizados = 0;
  let cancelados = 0;
  for (const p of pendientes) {
    const c = porSecuencia.get(Number(p.secuencia || 1));
    if (!c) {
      await db.query(
        `UPDATE remarketing_pendientes
            SET cancelado = 1, error_message = ?, ultimo_intento_at = NOW()
          WHERE id = ? AND enviado = 0 AND cancelado = 0`,
        {
          replacements: [
            'La secuencia de la columna se acortó al reconfigurarla: este paso ya no existe',
            p.id,
          ],
          type: db.QueryTypes.UPDATE,
        },
      );
      cancelados += 1;
      continue;
    }
    await db.query(
      `UPDATE remarketing_pendientes
          SET nombre_template = ?, language_code = ?, estado_destino = ?,
              header_format = ?, header_media_url = ?, header_media_name = ?,
              header_parameters = ?, id_template_rapido = ?, usar_respuesta_rapida = ?,
              metodo_dentro_24h = ?, prompt_ia = ?
        WHERE id = ? AND enviado = 0 AND cancelado = 0`,
      {
        replacements: [
          c.nombre_template || '',
          c.language_code || 'es',
          c.estado_destino || null,
          c.header_format || null,
          c.header_media_url
            ? String(c.header_media_url).replace(/&amp;/g, '&')
            : null,
          c.header_media_name || null,
          c.header_parameters || null,
          c.id_template_rapido || null,
          c.usar_respuesta_rapida ? 1 : 0,
          c.metodo_dentro_24h || 'ninguno',
          c.prompt_ia || null,
          p.id,
        ],
        type: db.QueryTypes.UPDATE,
      },
    );
    actualizados += 1;
  }
  return { actualizados, cancelados };
}

module.exports = { resincronizarPendientesRemarketing };
