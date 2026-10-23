/* Borrado completo del tablero de una configuración.

   Lo usan "Reiniciar configuración" (kanban_plantillas.controller) y "Adaptar
   el bot a mi negocio" (kanban_adaptar.service): los dos necesitan dejar la
   cuenta sin columnas antes de instalar otra cosa, y tenerlo en un solo lugar
   evita que una limpieza nueva (tableros secundarios, Dropi, remarketing…) se
   agregue en uno y falte en el otro. */

const { db } = require('../database/config');

/**
 * Borra columnas, acciones, tableros secundarios, remarketing y la config de
 * plantillas Dropi de la cuenta, y desvincula la plantilla global aplicada.
 *
 * @param {number} id_configuracion
 * @param {object} [o]
 * @param {string}  [o.motivo]        queda en configuraciones_kanban_global_log
 * @param {boolean} [o.eraProveedor]  si el tablero que se borra puso es_proveedor=1
 * @returns {Promise<{columnas_eliminadas:number, id_plantilla:number|null}>}
 */
async function reiniciarTablero(
  id_configuracion,
  { motivo = 'reinicio_manual', eraProveedor = false } = {},
) {
  const [config] = await db.query(
    `SELECT kanban_global_id FROM configuraciones WHERE id = ?`,
    { replacements: [id_configuracion], type: db.QueryTypes.SELECT },
  );
  const id_plantilla = config?.kanban_global_id || null;

  const columnas = await db.query(
    `SELECT id FROM kanban_columnas WHERE id_configuracion = ?`,
    { replacements: [id_configuracion], type: db.QueryTypes.SELECT },
  );

  if (columnas.length) {
    const ids = columnas.map((c) => Number(c.id)).filter(Number.isFinite);
    if (ids.length) {
      await db.query(
        `DELETE FROM kanban_acciones WHERE id_kanban_columna IN (${ids.join(',')})`,
        { type: db.QueryTypes.DELETE },
      );
    }
  }

  await db.query(`DELETE FROM kanban_columnas WHERE id_configuracion = ?`, {
    replacements: [id_configuracion],
    type: db.QueryTypes.DELETE,
  });

  /* Se borran TODAS las columnas (arriba), incluidas las de tableros
     secundarios: sus estados por contacto y los tableros quedarían colgando. */
  try {
    await db.query(
      `DELETE FROM clientes_estados_tablero WHERE id_configuracion = ?`,
      { replacements: [id_configuracion], type: db.QueryTypes.DELETE },
    );
    await db.query(`DELETE FROM kanban_tableros WHERE id_configuracion = ?`, {
      replacements: [id_configuracion],
      type: db.QueryTypes.DELETE,
    });
  } catch (e) {
    /* migración kanban_tableros sin aplicar: no hay nada que limpiar */
  }

  await db.query(
    `DELETE FROM configuracion_remarketing WHERE id_configuracion = ?`,
    { replacements: [id_configuracion], type: db.QueryTypes.DELETE },
  );

  /* Sin filtro de `proveedor` a propósito: los `columna_destino` de cualquier
     proveedor —Dropi o Aliclik— quedarían apuntando a columnas que ya no
     existen. */
  await db.query(
    `DELETE FROM dropi_plantillas_config WHERE id_configuracion = ?`,
    { replacements: [id_configuracion], type: db.QueryTypes.DELETE },
  );

  /* Se limpia TODO el rastro de la plantilla, no solo el vínculo: si
     prompt_version y pais_plantilla quedan, el aviso de "actualización
     disponible" reaparece sin motivo. */
  await db.query(
    `UPDATE configuraciones
        SET kanban_global_activo = 0, kanban_global_id = NULL,
            prompt_version = NULL, pais_plantilla = NULL${
              eraProveedor ? ', es_proveedor = 0' : ''
            }
      WHERE id = ?`,
    { replacements: [id_configuracion] },
  );

  if (id_plantilla) {
    await db.query(
      `INSERT INTO configuraciones_kanban_global_log
         (id_configuracion, id_plantilla, accion, detalle)
       VALUES (?, ?, 'eliminado', ?)`,
      {
        replacements: [
          id_configuracion,
          id_plantilla,
          JSON.stringify({ motivo, columnas_eliminadas: columnas.length }),
        ],
        type: db.QueryTypes.INSERT,
      },
    );
  }

  return { columnas_eliminadas: columnas.length, id_plantilla };
}

module.exports = { reiniciarTablero };
