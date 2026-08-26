'use strict';

/**
 * Foto del producto para plantillas con encabezado de IMAGEN (el caso que lo
 * motiva: PENDIENTE CONFIRMACION — una confirmación con la foto del pedido
 * vende más que texto plano).
 *
 * Escalera de resolución, de la más exacta a la más laxa — el cliente tiene
 * VARIOS modelos parecidos (relojes) y una foto equivocada es peor que
 * ninguna:
 *  1. La galería de la orden Dropi (orderdetails[].product.gallery[0].urlS3):
 *     es LA foto de ese producto, cero ambigüedad.
 *  2. El catálogo del cliente por external_id de Dropi (product_id de la
 *     orden) — match por ID, también exacto.
 *  3. El catálogo por NOMBRE: exacto normalizado, o contains solo si UN único
 *     producto matchea. Dos candidatos = ambiguo = sin foto.
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
  const prods = await db.query(
    `SELECT nombre, imagen_url, external_id FROM productos_chat_center
      WHERE id_configuracion = ? AND eliminado = 0
        AND imagen_url IS NOT NULL AND imagen_url != ''`,
    { replacements: [id_configuracion], type: db.QueryTypes.SELECT },
  );
  const porExternalId = new Map();
  const lista = [];
  for (const p of prods) {
    const item = { nombre: normNombreProducto(p.nombre), imagen_url: p.imagen_url };
    lista.push(item);
    if (p.external_id != null && String(p.external_id).trim()) {
      porExternalId.set(String(p.external_id).trim(), p.imagen_url);
    }
  }
  return { porExternalId, lista };
}

/* Nombre exacto normalizado; contains bidireccional SOLO si un único producto
   matchea — con dos candidatos es ambiguo y se prefiere no mandar foto. */
function matchImagenPorNombre(lista, nombre) {
  const objetivo = normNombreProducto(nombre);
  if (!objetivo) return null;
  const exacto = lista.find((p) => p.nombre === objetivo);
  if (exacto) return exacto.imagen_url;
  const contains = lista.filter(
    (p) => p.nombre && (p.nombre.includes(objetivo) || objetivo.includes(p.nombre)),
  );
  return contains.length === 1 ? contains[0].imagen_url : null;
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
    // 1) La foto que viene EN la orden: exacta por definición.
    const deOrden = urlGaleriaDropi(order);
    if (deOrden) return { url: deOrden, fuente: 'orden_dropi' };

    const details = Array.isArray(order?.orderdetails) ? order.orderdetails : [];
    const externalIds = details
      .map((d) => d?.product_id ?? d?.product?.id)
      .filter((x) => x != null)
      .map(String);
    const nombresOrden = details.map((d) => d?.product?.name).filter(Boolean);

    const { porExternalId, lista } = await mapaImagenesCatalogo(
      id_configuracion,
    );

    // 2) Por ID de Dropi (external_id): match exacto.
    for (const id of externalIds) {
      const url = porExternalId.get(id);
      if (url) return { url, fuente: 'catalogo_id' };
    }

    // 3) Por nombre, solo si es inequívoco.
    for (const nombre of [...nombresOrden, ...nombres]) {
      const url = matchImagenPorNombre(lista, nombre);
      if (url) return { url, fuente: 'catalogo_nombre' };
    }
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
  urlDesdeUrlS3,
  urlGaleriaDropi,
  normNombreProducto,
  headerImagenParaEnvio,
};
