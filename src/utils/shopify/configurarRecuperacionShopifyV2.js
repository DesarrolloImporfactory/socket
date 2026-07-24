'use strict';

const { db } = require('../../database/config');

// Body del template (para mostrar en el chat; {{1}} = producto)
const BODY_TEXT_V2 =
  '🛒 ¡Aún tienes tu pedido de {{1}} pendiente! No dejes que se agote. ' +
  'Completa tu compra ahora y recibe un descuento especial. 👇';

// Mapeo de variables del template: body {{1}} = producto; botón 0 (URL
// dinámico) = recovery_token → /carrito/:token → landing real del carrito.
const PARAMETROS_JSON_V2 = JSON.stringify({
  body: ['producto'],
  buttons: [{ index: 0, variable: 'recovery_token' }],
});

/**
 * Deja la config de recuperación de carritos apuntando a la plantilla v2 con
 * el botón URL dinámico. Solo toca configs que tengan Shopify conectado
 * (fila en shopify_configuraciones) y que aún usen la plantilla vieja o
 * ninguna — no pisa una plantilla personalizada por el cliente.
 *
 * @returns {Promise<number>} filas actualizadas (0 si no aplica)
 */
async function configurarRecuperacionShopifyV2(id_configuracion) {
  if (!id_configuracion) return 0;
  const [res] = await db.query(
    `UPDATE shopify_configuraciones
        SET nombre_template_recuperacion = 'carritos_abandonados_v2',
            parametros_json = ?,
            body_text = ?,
            language_code = 'es',
            updated_at = NOW()
      WHERE id_configuracion = ?
        AND (nombre_template_recuperacion IS NULL
             OR nombre_template_recuperacion = 'carritos_abandonados'
             OR nombre_template_recuperacion = 'carritos_abandonados_v2')`,
    { replacements: [PARAMETROS_JSON_V2, BODY_TEXT_V2, id_configuracion] },
  );
  return res?.affectedRows || 0;
}

module.exports = { configurarRecuperacionShopifyV2 };
