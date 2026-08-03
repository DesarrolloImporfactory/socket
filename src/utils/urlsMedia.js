/* Extracción y normalización de las urls de media que el bot manda al cliente.
 *
 * El problema que resuelve: las urls del catálogo pueden traer espacios. Cuando
 * el producto se importa de Dropi y el rehospedaje en S3 falla, se guarda la url
 * original, y en Dropi el nombre del objeto es literalmente el archivo que subió
 * el vendedor — cosas como "WhatsApp Image 2026-01-31 at 2.43.49 PM (1).jpeg" o
 * "PORTADA PRODUCTOS (4).png".
 *
 * El patrón que se usaba (`https?://[^\s]+`) cortaba en el primer espacio, así
 * que de una url de 130 caracteres salía una de 90. Ese link recortado se le
 * mandaba a Meta —que responde 200 pero nunca entrega— y además se guardaba
 * recortado, de modo que el dedupe comparaba la url completa contra la recortada
 * y nunca coincidían: la misma foto rota salía en cada mensaje.
 */

// Extensiones que sabemos que son media. Se usan para saber dónde TERMINA la
// url cuando tiene espacios en el medio.
const EXT_IMAGEN = 'jpe?g|png|webp|gif|bmp';
const EXT_VIDEO = 'mp4|mov|webm|avi|mkv|3gp';

/* Se prueba primero la forma "hasta una extensión conocida", que tolera
   espacios, y sólo si no calza se cae a "hasta el primer espacio", que es el
   comportamiento de siempre para urls sin extensión (por ejemplo las que llevan
   el id como parámetro). Tras la extensión se admite query o fragmento, para no
   perder cosas como `?v=2` en las urls firmadas.

   `.` no matchea saltos de línea y no se usa la bandera `s`, así que la url
   nunca se extiende más allá de su propia línea. */
const cuerpo = (exts) =>
  `https?:\\/\\/.*?\\.(?:${exts})(?:[?#]\\S*)?|https?:\\/\\/[^\\s]+`;

const TAGS_IMAGEN = 'producto_imagen_url|servicio_imagen_url|upsell_imagen_url';
const TAGS_VIDEO = 'producto_video_url|servicio_video_url';

function reImagen(flags = 'gi') {
  return new RegExp(
    `\\[(?:${TAGS_IMAGEN})\\]:\\s*(${cuerpo(EXT_IMAGEN)})`,
    flags,
  );
}

function reVideo(flags = 'gi') {
  return new RegExp(
    `\\[(?:${TAGS_VIDEO})\\]:\\s*(${cuerpo(EXT_VIDEO)})`,
    flags,
  );
}

/* Deja la url lista para mandársela a Meta: sin espacios ni caracteres sueltos.
   `encodeURI` respeta lo que ya está codificado —no convierte `%20` en `%2520`—
   así que es seguro aplicarla más de una vez. */
function normalizarUrlMedia(url) {
  const limpia = String(url || '').trim();
  if (!limpia) return '';
  try {
    return encodeURI(decodeURI(limpia));
  } catch {
    // decodeURI revienta si hay un `%` suelto que no forma un escape válido.
    return encodeURI(limpia);
  }
}

/**
 * Saca de un texto las urls de imagen y de video, ya normalizadas, y devuelve
 * también el texto sin esas líneas.
 */
function extraerUrlsMedia(texto) {
  const original = String(texto || '');

  const sacar = (re) => {
    const out = [];
    for (const m of original.matchAll(re)) {
      const u = normalizarUrlMedia(m[1]);
      if (u) out.push(u);
    }
    return out;
  };

  const imagenes = sacar(reImagen());
  const videos = sacar(reVideo());

  const textoLimpio = original.replace(reImagen(), '').replace(reVideo(), '');

  return { texto: textoLimpio, imagenes, videos };
}

module.exports = {
  extraerUrlsMedia,
  normalizarUrlMedia,
  reImagen,
  reVideo,
};
