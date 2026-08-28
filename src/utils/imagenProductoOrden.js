'use strict';

/**
 * Foto del producto para plantillas con encabezado de IMAGEN (el caso que lo
 * motiva: PENDIENTE CONFIRMACION — una confirmación con la foto del pedido
 * vende más que texto plano).
 *
 * Escalera de resolución — el cliente tiene VARIOS modelos parecidos
 * (relojes) y una foto equivocada es peor que ninguna. EL CATÁLOGO MANDA:
 * al importar de Dropi queda la foto de Dropi, pero el negocio casi siempre
 * la reemplaza por la suya (editada, con su marca) — esa personalizada es la
 * que debe salir, no la cruda de Dropi:
 *  1. El catálogo del cliente por external_id de Dropi (product_id de la
 *     orden) — la imagen que el negocio MANTIENE en su producto.
 *  2. El catálogo por NOMBRE: exacto normalizado, o contains solo si UN único
 *     producto matchea. Dos candidatos = ambiguo = se sigue bajando.
 *  3. La galería de la orden Dropi (orderdetails[].product.gallery[0].urlS3):
 *     respaldo para productos no importados al catálogo o sin imagen.
 *  4. Nada → quien llama decide (imagen de ejemplo de la plantilla, o error
 *     visible).
 */

const { db } = require('../database/config');

// Mismo CDN que usa la importación de productos Dropi
// (productos_chat_center.controller.js).
const CDN_DROPI = 'https://d39ru7awumhhs2.cloudfront.net';

function urlDesdeUrlS3(ruta) {
  const s = String(ruta || '').trim();
  if (!s) return null;
  if (/^https?:\/\//i.test(s)) return s;
  return `${CDN_DROPI}/${s.replace(/^\//, '')}`;
}

function urlGaleriaDropi(order) {
  const details = Array.isArray(order?.orderdetails) ? order.orderdetails : [];
  for (const d of details) {
    const g = d?.product?.gallery;
    const url = Array.isArray(g) && g[0]?.urlS3 ? urlDesdeUrlS3(g[0].urlS3) : null;
    if (url) return url;
  }
  return null;
}

const normNombreProducto = (s) =>
  String(s || '')
    .toUpperCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * Carga UNA vez el catálogo con imagen de una configuración, indexado para
 * matchear por external_id (Dropi) y por nombre. Para lotes (flujos masivos)
 * se carga una vez y se matchea en memoria; para un envío suelto (notifier)
 * también sirve tal cual.
 */
async function mapaImagenesCatalogo(id_configuracion) {
  /* video_url viaja junto a la imagen para las plantillas con encabezado de
     VIDEO (flujos masivos): mismo catálogo, misma escalera. Se carga el
     catálogo COMPLETO (también productos sin media): el producto del ANUNCIO
     por el que entró un contacto sirve aunque no tenga foto — da nombre y
     precio para las variables. Los match por campo filtran solo donde el
     campo existe, así que el comportamiento de imagen/video no cambia. */
  const prods = await db.query(
    `SELECT id, nombre, precio, imagen_url, video_url, external_id
       FROM productos_chat_center
      WHERE id_configuracion = ? AND eliminado = 0`,
    { replacements: [id_configuracion], type: db.QueryTypes.SELECT },
  );
  const porExternalId = new Map();
  const porExternalIdVideo = new Map();
  const porIdProducto = new Map();
  const lista = [];
  for (const p of prods) {
    const item = {
      id: p.id,
      nombre: normNombreProducto(p.nombre),
      nombre_original: p.nombre,
      precio: p.precio != null ? String(p.precio) : null,
      imagen_url: p.imagen_url || null,
      video_url: p.video_url || null,
    };
    lista.push(item);
    porIdProducto.set(Number(p.id), item);
    if (p.external_id != null && String(p.external_id).trim()) {
      const eid = String(p.external_id).trim();
      if (p.imagen_url) porExternalId.set(eid, p.imagen_url);
      if (p.video_url) porExternalIdVideo.set(eid, p.video_url);
    }
  }
  return { porExternalId, porExternalIdVideo, porIdProducto, lista };
}

/* Nombre exacto normalizado; contains bidireccional SOLO si un único producto
   matchea — con dos candidatos es ambiguo y se prefiere no mandar nada.
   Se matchea SOLO entre productos que tienen el campo pedido, para que un
   producto sin imagen (pero con video) no "gane" un match de imagen vacío. */
function matchCampoPorNombre(lista, nombre, campo) {
  const objetivo = normNombreProducto(nombre);
  if (!objetivo) return null;
  const candidatos = lista.filter((p) => p[campo]);
  const exacto = candidatos.find((p) => p.nombre === objetivo);
  if (exacto) return exacto[campo];
  const contains = candidatos.filter(
    (p) => p.nombre && (p.nombre.includes(objetivo) || objetivo.includes(p.nombre)),
  );
  return contains.length === 1 ? contains[0][campo] : null;
}

function matchImagenPorNombre(lista, nombre) {
  return matchCampoPorNombre(lista, nombre, 'imagen_url');
}

function matchVideoPorNombre(lista, nombre) {
  return matchCampoPorNombre(lista, nombre, 'video_url');
}

/**
 * @param {object} p
 * @param {number} p.id_configuracion
 * @param {object} [p.order]    orden Dropi (con orderdetails) si se tiene
 * @param {string[]} [p.nombres] nombres de producto (line_items de Shopify u
 *                               otra fuente) para el match por catálogo
 * @returns {Promise<{url:string, fuente:'orden_dropi'|'catalogo_id'|'catalogo_nombre'}|null>}
 */
async function resolverImagenProductoOrden({
  id_configuracion,
  order = null,
  nombres = [],
}) {
  try {
    const details = Array.isArray(order?.orderdetails) ? order.orderdetails : [];
    const externalIds = details
      .map((d) => d?.product_id ?? d?.product?.id)
      .filter((x) => x != null)
      .map(String);
    const nombresOrden = details.map((d) => d?.product?.name).filter(Boolean);

    const { porExternalId, lista } = await mapaImagenesCatalogo(
      id_configuracion,
    );

    // 1) El catálogo por ID de Dropi: la imagen que el negocio mantiene.
    for (const id of externalIds) {
      const url = porExternalId.get(id);
      if (url) return { url, fuente: 'catalogo_id' };
    }

    // 2) El catálogo por nombre, solo si es inequívoco.
    for (const nombre of [...nombresOrden, ...nombres]) {
      const url = matchImagenPorNombre(lista, nombre);
      if (url) return { url, fuente: 'catalogo_nombre' };
    }

    // 3) Respaldo: la foto cruda que viene en la orden de Dropi.
    const deOrden = urlGaleriaDropi(order);
    if (deOrden) return { url: deOrden, fuente: 'orden_dropi' };
  } catch (_) {
    // best-effort: sin foto, quien llama decide
  }
  return null;
}

/**
 * Componente de header listo para el envío de una plantilla con encabezado
 * IMAGE. Meta NO permite enviar esa plantilla sin imagen, así que aquí no
 * existe "sale sin foto": la escalera termina en la imagen de EJEMPLO de la
 * plantilla (la que el negocio subió al crearla) — resubida como media id
 * porque el handle de Meta es efímero y como link falla la descarga.
 * Devuelve null solo si ni el ejemplo se pudo resolver: en ese caso el envío
 * va a fallar y el log de quien llama debe decirlo con claridad.
 *
 * @param {object} p
 * @param {object} p.def          definición de la plantilla (obtenerTextoPlantilla)
 * @param {string|null} p.imagenUrl  foto del producto ya resuelta (o null)
 * @param {string} p.business_phone_id
 * @param {string} p.accessToken
 * @param {string} p.nombre_template
 * @returns {Promise<object|null>}  { type:'header', parameters:[...] } o null
 */
async function headerImagenParaEnvio({
  def,
  imagenUrl,
  business_phone_id,
  accessToken,
  nombre_template,
}) {
  if (String(def?.header?.format || '').toUpperCase() !== 'IMAGE') return null;

  if (imagenUrl) {
    return {
      type: 'header',
      parameters: [{ type: 'image', image: { link: imagenUrl } }],
    };
  }

  const ejemplo = def?.header?.media_url || null;
  if (!ejemplo) return null;
  try {
    const {
      esHandleEfimeroDeMeta,
      resolverMediaIdDeHeader,
    } = require('../services/whatsapp.service');
    if (!esHandleEfimeroDeMeta(ejemplo)) {
      return {
        type: 'header',
        parameters: [{ type: 'image', image: { link: ejemplo } }],
      };
    }
    const media = await resolverMediaIdDeHeader({
      url: ejemplo,
      business_phone_id,
      accessToken,
      nombre_template,
    });
    if (media?.mediaId) {
      return {
        type: 'header',
        parameters: [{ type: 'image', image: { id: String(media.mediaId) } }],
      };
    }
  } catch (_) {}
  return null;
}

module.exports = {
  resolverImagenProductoOrden,
  mapaImagenesCatalogo,
  matchImagenPorNombre,
  matchVideoPorNombre,
  urlDesdeUrlS3,
  urlGaleriaDropi,
  normNombreProducto,
  headerImagenParaEnvio,
};
