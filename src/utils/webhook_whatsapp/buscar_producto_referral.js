// utils/webhook_whatsapp/buscar_producto_referral.js
const { db } = require('../../database/config');
const { resolverUpsell, directivaUpsell } = require('../upsellProducto');

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

// Arma el bloque de texto que se le inyecta a la IA. `upsell` viene de
// resolverUpsell (referencia en vivo o campos legacy); con null no se ofrece.
function armarBloqueProducto(p, upsell = null) {
  const imagen = encodeUrl(p.imagen_url);
  const video = encodeUrl(p.video_url);
  const combos = formatearCombos(p.combos_producto);

  let b = '';
  b += `🛒 Producto: ${p.nombre || ''}\n`;
  b += `📃 Descripción: ${p.descripcion || ''}\n`;
  b += `Precio: ${p.precio ?? ''}\n`;
  if (combos) b += `${combos}\n`;
  if (imagen) b += `[producto_imagen_url]: ${imagen}\n`;
  if (video) b += `[producto_video_url]: ${video}\n`;
  if (upsell) {
    b += `${directivaUpsell(upsell)}\n`;
    const imgUp = encodeUrl(upsell.imagen_url);
    if (imgUp) b += `[upsell_imagen_url]: ${imgUp}\n`;
  }
  return b.trim();
}

const CAMPOS_PRODUCTO = `id, id_configuracion, nombre, descripcion, precio,
              imagen_url, video_url, combos_producto, stock, id_producto_upsell,
              nombre_upsell, descripcion_upsell, precio_upsell, imagen_upsell_url`;

/* Normalización para el nivel 2.5: minúsculas, sin tildes, sin signos.
   `nucleo` además bota los tokens con dígitos (gramajes/tallas: "400GR",
   "567G") y `compacto` quita los espacios, para que "CubreCanas" (junto)
   calce con "Cubre Canas" (separado). */
function normalizar(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[^a-z0-9ñ]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}
function nucleoCompacto(s) {
  return normalizar(s)
    .split(' ')
    .filter((t) => !/\d/.test(t))
    .join('');
}

/**
 * Resuelve QUÉ producto publicita un anuncio. Es la única fuente de esa
 * verdad: la usan el webhook (para armar el bloque del referral) y
 * contextoColumna (para anclar el producto de la conversación). Antes cada uno
 * resolvía por su cuenta y podían no coincidir.
 *
 * El orden va de lo determinista a lo difuso:
 *
 *   0. El MAPA (anuncios_producto, por source_id). Un anuncio publicita
 *      siempre el mismo producto, así que la adivinanza de texto se hace UNA
 *      vez en la vida del anuncio; después es una búsqueda exacta. Es lo único
 *      que resuelve los títulos de puro marketing ("Luce 2 tallas menos"), que
 *      son ~1 de cada 4 anuncios y no contienen ningún nombre de producto.
 *   1. Nombre exacto.
 *   2. Contenido (el título contiene el nombre o al revés). Gana el nombre MÁS
 *      LARGO: con "Corrector de Postura" y "Corrector de Postura Pro" en el
 *      mismo catálogo, el corto calza en los dos anuncios y el orden ASC que
 *      había antes elegía siempre la versión equivocada.
 *   3. Palabras sueltas (la que más coincida). Es el nivel difuso: sirve para
 *      responder, pero NO se graba en el mapa — grabar una adivinanza como
 *      verdad es como nació el problema que esto arregla.
 *
 * Aprende solo: si resolvió por 1 o 2 y hay source_id, guarda el vínculo.
 *
 * @returns {Promise<{producto: object, via: string}|null>}
 */
async function resolverProductoAnuncio(id_configuracion, headline, source_id) {
  const nombre = String(headline || '').trim();
  const ad = String(source_id || '').trim();

  try {
    // ── Nivel 0: el mapa ─────────────────────────────────────
    if (ad) {
      const [map] = await db.query(
        `SELECT ap.id_producto FROM anuncios_producto ap
          WHERE ap.id_configuracion = ? AND ap.source_id = ?
          LIMIT 1`,
        { replacements: [id_configuracion, ad], type: db.QueryTypes.SELECT },
      );
      if (map) {
        const [p] = await db.query(
          `SELECT ${CAMPOS_PRODUCTO} FROM productos_chat_center
            WHERE id = ? AND eliminado = 0 LIMIT 1`,
          { replacements: [map.id_producto], type: db.QueryTypes.SELECT },
        );
        if (p) {
          db.query(
            `UPDATE anuncios_producto SET veces = veces + 1
              WHERE id_configuracion = ? AND source_id = ?`,
            { replacements: [id_configuracion, ad], type: db.QueryTypes.UPDATE },
          ).catch(() => {});
          return { producto: p, via: 'mapa' };
        }
        /* El producto del mapa ya no existe (lo borraron del catálogo y lo
           re-crearon con otro id): la fila rota se ELIMINA, no solo se ignora.
           Dejarla era una trampa doble — el nivel 0 fallaba para siempre Y el
           ON DUPLICATE del aprendizaje solo subía `veces`, sin corregir el
           id_producto muerto. Caso real (403, 2026-08-19): el mapa del anuncio
           "SSD PORTATIL DE 8TB" apuntaba al producto borrado 2375, el nivel 3
           quedó solo con la palabra "PORTATIL" y el bot terminó cotizando la
           Máquina de Hielo SOKANY con foto y todo. */
        db.query(
          `DELETE FROM anuncios_producto
            WHERE id_configuracion = ? AND source_id = ?`,
          { replacements: [id_configuracion, ad], type: db.QueryTypes.DELETE },
        ).catch(() => {});
      }
    }

    if (!nombre) return null;

    // ── Nivel 1: match exacto ────────────────────────────────
    let productos = await db.query(
      `SELECT ${CAMPOS_PRODUCTO} FROM productos_chat_center
        WHERE id_configuracion = ? AND eliminado = 0 AND nombre = ?
        LIMIT 2`,
      { replacements: [id_configuracion, nombre], type: db.QueryTypes.SELECT },
    );
    let via = 'exacto';

    // ── Nivel 2: contenido, el nombre más largo primero ──────
    if (!productos.length) {
      productos = await db.query(
        `SELECT ${CAMPOS_PRODUCTO} FROM productos_chat_center
          WHERE id_configuracion = ? AND eliminado = 0
            AND (nombre LIKE ? OR ? LIKE CONCAT('%', nombre, '%'))
          ORDER BY CHAR_LENGTH(nombre) DESC
          LIMIT 2`,
        {
          replacements: [id_configuracion, `%${nombre}%`, nombre],
          type: db.QueryTypes.SELECT,
        },
      );
      via = 'contenido';
    }

    /* ── Nivel 2.5: contenido NORMALIZADO ─────────────────────
       El LIKE del nivel 2 compara los textos tal cual, y el catálogo real
       viene con ruido de formato que lo rompe: en la 569 el anuncio decía
       "Shampoo CubreCanas IVSI" y el producto "Shampoo Cubre Canas 400GR*"
       (junto vs separado + gramaje), o "FIBER GUMMIES" contra "*FIBER
       Gummies*" (asteriscos). Nada aprendía y 6.000 tarjetas del kanban
       quedaron sin producto. Aquí se compara el núcleo compactado (sin
       signos, sin gramajes, sin espacios) en JS sobre el catálogo de la
       config, que es chico. Mismo espíritu que el nivel 2: gana el nombre
       más largo y EN EMPATE NO SE ADIVINA. El piso de 8 caracteres evita
       que un nombre cortito calce dentro de cualquier titular. */
    if (!productos.length) {
      const hc = nucleoCompacto(nombre);
      if (hc.length >= 8) {
        const catalogo = await db.query(
          `SELECT ${CAMPOS_PRODUCTO} FROM productos_chat_center
            WHERE id_configuracion = ? AND eliminado = 0`,
          { replacements: [id_configuracion], type: db.QueryTypes.SELECT },
        );
        const matches = catalogo
          .map((p) => ({ p, pn: nucleoCompacto(p.nombre) }))
          .filter(
            ({ pn }) =>
              pn.length >= 8 && (hc.includes(pn) || pn.includes(hc)),
          )
          .sort((a, b) => b.pn.length - a.pn.length);
        const empate =
          matches.length > 1 && matches[1].pn.length === matches[0].pn.length;
        if (matches.length && !empate) productos = [matches[0].p];
      }
      via = 'contenido';
    }

    // ── Nivel 3: por palabras clave (no se aprende) ──────────
    if (!productos.length) {
      const palabras = nombre
        .split(/\s+/)
        .filter((w) => w.length >= 4)
        .slice(0, 5);

      if (palabras.length) {
        const condiciones = palabras.map(() => 'nombre LIKE ?').join(' OR ');
        const scoring = palabras
          .map(() => '(CASE WHEN nombre LIKE ? THEN 1 ELSE 0 END)')
          .join(' + ');

        /* Se piden 3 filas y se decide en JS, con la misma filosofía del
           matcher del auto-orden: EN EMPATE, MEJOR NO ADIVINAR. Antes el
           LIMIT 1 con desempate por nombre corto era una lotería: "SSD
           PORTATIL DE 8TB" deja una sola palabra útil ("PORTATIL" — SSD y
           8TB miden 3 letras y el filtro exige 4), tres productos empataban
           a score 1 y ganaba la Máquina de Hielo por tener el nombre más
           corto. Además, con 2+ palabras útiles una sola coincidencia es
           señal demasiado floja para inyectar "usa SOLO estos precios".
           Devolver null aquí NO deja mudo al bot: sin ficha del anuncio, el
           modelo usa el catálogo (inline/file_search) — que en este mismo
           caso respondió el SSD correcto cuando el cliente lo nombró. */
        const filas = await db.query(
          `SELECT ${CAMPOS_PRODUCTO}, (${scoring}) AS score
             FROM productos_chat_center
            WHERE id_configuracion = ? AND eliminado = 0 AND (${condiciones})
            ORDER BY score DESC, CHAR_LENGTH(nombre) ASC
            LIMIT 3`,
          {
            replacements: [
              ...palabras.map((w) => `%${w}%`),
              id_configuracion,
              ...palabras.map((w) => `%${w}%`),
            ],
            type: db.QueryTypes.SELECT,
          },
        );
        const top = filas[0];
        const minScore = Math.min(2, palabras.length);
        const empate =
          filas.length > 1 && Number(filas[1].score) === Number(top?.score);
        productos =
          top && Number(top.score) >= minScore && !empate ? [top] : [];
      }
      via = 'palabras';
    }

    if (!productos.length) return null;
    const producto = productos[0];

    // ── Aprender, solo de los niveles confiables ─────────────
    if (ad && (via === 'exacto' || via === 'contenido')) {
      db.query(
        `INSERT INTO anuncios_producto
           (id_configuracion, source_id, id_producto, headline, via)
         VALUES (?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           id_producto = VALUES(id_producto),
           via = VALUES(via),
           veces = veces + 1`,
        {
          replacements: [
            id_configuracion,
            ad,
            producto.id,
            nombre.slice(0, 500),
            via,
          ],
          type: db.QueryTypes.INSERT,
        },
      ).catch(() => {});
    }

    return { producto, via };
  } catch (err) {
    return null;
  }
}

/**
 * Busca el producto del referral en la BD y devuelve un bloque
 * de texto con los datos EXACTOS para inyectar a la IA.
 *
 * @returns {Promise<string>} bloque listo o '' si no encuentra
 */
async function buscarProductoPorReferral(id_configuracion, headline, source_id) {
  const r = await resolverProductoAnuncio(id_configuracion, headline, source_id);
  if (!r) return '';
  // Devuelve SOLO los datos del producto. La instrucción la arma el webhook.
  const upsell = await resolverUpsell(r.producto);
  return armarBloqueProducto(r.producto, upsell);
}

module.exports = { buscarProductoPorReferral, resolverProductoAnuncio };
