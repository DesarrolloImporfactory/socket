// utils/upsellProducto.js
// Upsell por referencia: `productos_chat_center.id_producto_upsell` apunta a
// OTRO producto del mismo catálogo. El bot lo ofrece UNA vez cuando el cliente
// confirma la compra y, si acepta, lo escribe como línea extra del resumen
// ("📦 Producto: <nombre> x1") — el auto-orden multi-producto ya sube esa
// línea a Dropi (validando que salga de la misma bodega). Los campos de texto
// libres (nombre_upsell / precio_upsell / imagen_upsell_url) siguen valiendo
// como upsell "informativo" para cuentas viejas, pero sin id no entran a la
// orden automática.
const { db } = require('../database/config');

/**
 * Datos EN VIVO del upsell de un producto, o null si no tiene.
 * Prioridad: id_producto_upsell (referencia) → campos de texto legacy.
 * @param {object} p fila de productos_chat_center (necesita id_configuracion,
 *   id_producto_upsell y opcionalmente los campos legacy)
 */
async function resolverUpsell(p) {
  if (!p) return null;
  const idRef = Number(p.id_producto_upsell);
  if (Number.isFinite(idRef) && idRef > 0 && idRef !== Number(p.id)) {
    try {
      const [ref] = await db.query(
        `SELECT id, nombre, precio, imagen_url, stock, external_source, external_id
           FROM productos_chat_center
          WHERE id = ? AND id_configuracion = ? AND eliminado = 0
          LIMIT 1`,
        {
          replacements: [idRef, p.id_configuracion],
          type: db.QueryTypes.SELECT,
        },
      );
      if (ref) {
        const stock = Number(ref.stock);
        // Un upsell agotado no se ofrece: sería vender lo que no hay.
        if (Number.isFinite(stock) && stock <= 0) return null;
        return {
          id: ref.id,
          nombre: ref.nombre,
          precio: ref.precio,
          imagen_url: ref.imagen_url || null,
          referencia: true,
        };
      }
    } catch {
      /* si la consulta falla, se cae al legacy */
    }
  }
  if (p.nombre_upsell) {
    return {
      id: null,
      nombre: p.nombre_upsell,
      precio: p.precio_upsell ?? null,
      imagen_url: p.imagen_upsell_url || null,
      referencia: false,
    };
  }
  return null;
}

const fmt = (v) => {
  const n = Number(String(v ?? '').replace(',', '.'));
  return Number.isFinite(n) ? `$${n.toFixed(2)}` : String(v ?? '');
};

/**
 * Instrucción que se inyecta junto a la ficha del producto. Si `up` es null
 * devuelve '' (producto sin upsell → el bot no ofrece nada).
 */
function directivaUpsell(up) {
  if (!up || !up.nombre) return '';
  const precio = up.precio != null && up.precio !== '' ? ` por ${fmt(up.precio)}` : '';
  return (
    `🛍️ UPSELL — OFERTA OBLIGATORIA (una sola vez, manda sobre el guion): en el ` +
    `PRIMER mensaje después de que el cliente confirme que lleva el producto ` +
    `(diga que sí, o cuántas unidades quiere), ANTES de pedirle sus datos y en ese ` +
    `mismo mensaje, ofrécele agregar "${up.nombre}"${precio}. Ejemplo: "¡Buena ` +
    `elección! Antes de despachar tu pedido: ¿deseas agregar ${up.nombre}${precio} ` +
    `a tu orden? 🙌" y a continuación pide los datos que tu guion indique. ` +
    `Si el cliente ACEPTA, el resumen final lleva DOS líneas de producto: ` +
    `"📦 Producto: <producto principal> x<cantidad>" y "📦 Producto: ${up.nombre} x1", ` +
    `y el total suma el upsell. Si lo rechaza o lo ignora: no insistas, no lo ` +
    `menciones de nuevo y NO lo incluyas en el resumen. Ofrécelo UNA sola vez en ` +
    `toda la conversación.`
  );
}

module.exports = { resolverUpsell, directivaUpsell };
