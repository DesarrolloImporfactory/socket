// utils/webhook_whatsapp/buscar_producto_referral.js
const { db } = require('../../database/config');

// Codifica el filename de la URL (igual que hace tu sync de catálogo)
function encodeUrl(url) {
  if (!url) return null;
  try {
    const lastSlash = url.lastIndexOf('/');
    const base = url.substring(0, lastSlash + 1);
    const filename = url.substring(lastSlash + 1);
    return base + encodeURIComponent(filename);
  } catch {
    return url;
  }
}

function safeJSONParse(value, fallback = null) {
  if (value == null) return fallback;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function formatearCombos(combosProducto) {
  const combos = safeJSONParse(combosProducto, null);
  if (!combos || !Array.isArray(combos) || !combos.length) return '';
  let txt = 'Combos disponibles:\n';
  combos.forEach((c, i) => {
    const nombre = c?.nombre || c?.titulo || `Combo ${i + 1}`;
    const precio = c?.precio ?? c?.valor ?? '';
    const cantidad = c?.cantidad ?? '';
    txt += `- ${nombre}`;
    if (cantidad) txt += ` | Cantidad: ${cantidad}`;
    if (precio !== '') txt += ` | Precio: ${precio}`;
    txt += '\n';
  });
  return txt.trim();
}

// Arma el bloque de texto que se le inyecta a la IA
function armarBloqueProducto(p) {
  const imagen = encodeUrl(p.imagen_url);
  const video = encodeUrl(p.video_url);
  const imagenUpsell = encodeUrl(p.imagen_upsell_url);
  const combos = formatearCombos(p.combos_producto);

  let b = '';
  b += `🛒 Producto: ${p.nombre || ''}\n`;
  b += `📃 Descripción: ${p.descripcion || ''}\n`;
  b += `Precio: ${p.precio ?? ''}\n`;
  if (combos) b += `${combos}\n`;
  if (imagen) b += `[producto_imagen_url]: ${imagen}\n`;
  if (video) b += `[producto_video_url]: ${video}\n`;
  if (p.nombre_upsell) b += `Nombre_upsell: ${p.nombre_upsell}\n`;
  if (p.precio_upsell != null) b += `Precio_upsell: ${p.precio_upsell}\n`;
  if (imagenUpsell) b += `[upsell_imagen_url]: ${imagenUpsell}\n`;
  return b.trim();
}

/**
 * Busca el producto del referral en la BD y devuelve un bloque
 * de texto con los datos EXACTOS para inyectar a la IA.
 *
 * @returns {Promise<string>} bloque listo o '' si no encuentra
 */
async function buscarProductoPorReferral(id_configuracion, headline) {
  const nombre = String(headline || '').trim();
  if (!nombre) return '';

  try {
    // ── Nivel 1: match exacto ────────────────────────────────
    let productos = await db.query(
      `SELECT nombre, descripcion, precio, imagen_url, video_url,
              combos_producto, stock, nombre_upsell, descripcion_upsell,
              precio_upsell, imagen_upsell_url
       FROM   productos_chat_center
       WHERE  id_configuracion = ? AND nombre = ?
       LIMIT 2`,
      { replacements: [id_configuracion, nombre], type: db.QueryTypes.SELECT },
    );

    // ── Nivel 2: LIKE (el nombre contiene el headline o viceversa) ──
    if (!productos.length) {
      productos = await db.query(
        `SELECT nombre, descripcion, precio, imagen_url, video_url,
                combos_producto, stock, nombre_upsell, descripcion_upsell,
                precio_upsell, imagen_upsell_url
         FROM   productos_chat_center
         WHERE  id_configuracion = ?
           AND  (nombre LIKE ? OR ? LIKE CONCAT('%', nombre, '%'))
         ORDER  BY CHAR_LENGTH(nombre) ASC
         LIMIT 2`,
        {
          replacements: [id_configuracion, `%${nombre}%`, nombre],
          type: db.QueryTypes.SELECT,
        },
      );
    }

    // ── Nivel 3: por palabras clave (la que más coincida) ─────
    if (!productos.length) {
      const palabras = nombre
        .split(/\s+/)
        .filter((w) => w.length >= 4) // ignora "de", "el", "las"...
        .slice(0, 5);

      if (palabras.length) {
        const condiciones = palabras.map(() => 'nombre LIKE ?').join(' OR ');
        const scoring = palabras
          .map(() => '(CASE WHEN nombre LIKE ? THEN 1 ELSE 0 END)')
          .join(' + ');

        productos = await db.query(
          `SELECT nombre, descripcion, precio, imagen_url, video_url,
                  combos_producto, stock, nombre_upsell, descripcion_upsell,
                  precio_upsell, imagen_upsell_url,
                  (${scoring}) AS score
           FROM   productos_chat_center
           WHERE  id_configuracion = ? AND (${condiciones})
           ORDER  BY score DESC, CHAR_LENGTH(nombre) ASC
           LIMIT 1`,
          {
            replacements: [
              ...palabras.map((w) => `%${w}%`), // para el scoring
              id_configuracion,
              ...palabras.map((w) => `%${w}%`), // para el WHERE
            ],
            type: db.QueryTypes.SELECT,
          },
        );
      }
    }

    if (!productos.length) return '';

    // Devuelve SOLO los datos del producto. La instrucción la arma el webhook.
    return productos.map(armarBloqueProducto).join('\n\n');
  } catch (err) {
    return '';
  }
}

module.exports = { buscarProductoPorReferral };
