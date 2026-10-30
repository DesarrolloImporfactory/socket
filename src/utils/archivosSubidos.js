/**
 * Registro de archivos ya subidos (S3 vía uploader y Video API) para no
 * volver a subir lo mismo.
 *
 * El uploader de imporfactory crea un objeto nuevo en S3 en cada llamada
 * (le agrega un timestamp al nombre), así que el mismo adjunto de una
 * plantilla terminaba 200 veces en el bucket: una por cada envío. Aquí se
 * guarda el sha256 del contenido → URL devuelta, y quien va a subir pregunta
 * primero. La tabla la crea archivos_subidos_chat_center_migration.sql; si
 * no existe, se avisa una vez y se sigue subiendo como antes.
 *
 * También vive aquí la memoria de media_id de Meta (por número + archivo):
 * Meta conserva un media_id 30 días, así que mandar la misma plantilla a
 * varios clientes no necesita resubir el adjunto a /media cada vez.
 */
const crypto = require('crypto');
const { db } = require('../database/config');

const TTL_MEMORIA_MS = 10 * 60 * 1000;
const memoria = new Map(); // `${destino}:${hash}` → { valor, en }
let tablaFalta = false;

const hashDe = (buffer) =>
  crypto.createHash('sha256').update(buffer).digest('hex');

const faltaTabla = (e) =>
  /doesn't exist|ER_NO_SUCH_TABLE|no such table/i.test(String(e?.message));

function avisarTablaFalta() {
  if (tablaFalta) return;
  tablaFalta = true;
  console.warn(
    '[archivosSubidos] Falta la tabla archivos_subidos_chat_center ' +
      '(aplicar archivos_subidos_chat_center_migration.sql). Mientras tanto ' +
      'cada subida crea un archivo nuevo, como antes.',
  );
}

/** @returns {{ url: string, respuesta: object|null }|null} */
async function buscarSubida(hash, destino = 's3') {
  const k = `${destino}:${hash}`;
  const m = memoria.get(k);
  if (m && Date.now() - m.en < TTL_MEMORIA_MS) return m.valor;
  if (tablaFalta) return null;
  try {
    const [fila] = await db.query(
      `SELECT url, respuesta FROM archivos_subidos_chat_center
        WHERE hash = :hash AND destino = :destino LIMIT 1`,
      { replacements: { hash, destino }, type: db.QueryTypes.SELECT },
    );
    if (!fila?.url) return null;
    let respuesta = fila.respuesta;
    if (typeof respuesta === 'string') {
      try {
        respuesta = JSON.parse(respuesta);
      } catch {
        respuesta = null;
      }
    }
    const valor = { url: fila.url, respuesta: respuesta || null };
    memoria.set(k, { valor, en: Date.now() });
    db.query(
      `UPDATE archivos_subidos_chat_center
          SET veces = veces + 1, ultimo_uso_at = NOW()
        WHERE hash = :hash AND destino = :destino`,
      { replacements: { hash, destino }, type: db.QueryTypes.UPDATE },
    ).catch(() => {});
    return valor;
  } catch (e) {
    if (faltaTabla(e)) avisarTablaFalta();
    else console.warn('[archivosSubidos] buscar:', e.message);
    return null;
  }
}

async function registrarSubida({
  hash,
  destino = 's3',
  url,
  respuesta = null,
  bytes = 0,
  mimetype = null,
  nombre = null,
}) {
  if (!hash || !url) return;
  memoria.set(`${destino}:${hash}`, {
    valor: { url, respuesta },
    en: Date.now(),
  });
  if (tablaFalta) return;
  try {
    await db.query(
      `INSERT INTO archivos_subidos_chat_center
         (hash, destino, url, respuesta, bytes, mimetype, nombre)
       VALUES (:hash, :destino, :url, :respuesta, :bytes, :mimetype, :nombre)
       ON DUPLICATE KEY UPDATE url = VALUES(url), respuesta = VALUES(respuesta),
         veces = veces + 1, ultimo_uso_at = NOW()`,
      {
        replacements: {
          hash,
          destino,
          url: String(url).slice(0, 1000),
          respuesta: respuesta ? JSON.stringify(respuesta) : null,
          bytes: Number(bytes) || 0,
          mimetype: mimetype ? String(mimetype).slice(0, 120) : null,
          nombre: nombre ? String(nombre).slice(0, 255) : null,
        },
        type: db.QueryTypes.INSERT,
      },
    );
  } catch (e) {
    if (faltaTabla(e)) avisarTablaFalta();
    else console.warn('[archivosSubidos] registrar:', e.message);
  }
}

/**
 * ¿La URL ya es un archivo nuestro (S3 por el uploader o la Video API)?
 * Si lo es, no hay que "guardarlo en histórico" otra vez: la URL ya sirve.
 */
function esUrlPropia(url) {
  try {
    const h = new URL(String(url)).hostname.toLowerCase();
    return (
      h === 'imp-datas.s3.amazonaws.com' ||
      h === 'uploader.imporfactory.app' ||
      h === 'new.imporsuitpro.com'
    );
  } catch {
    return false;
  }
}

/* ── media_id de Meta por número + archivo ─────────────────────────────── */

const MEDIA_ID_TTL_MS = 6 * 60 * 60 * 1000; // el id vive 30 días en Meta
const MEDIA_ID_MAX = 5000;
const mediaIds = new Map(); // `${phone}::${clave}` → { media, en }

/** Clave sin querystring: la firma de la URL cambia, el archivo no. */
function claveDeUrl(x) {
  const s = String(x || '');
  if (!/^https?:\/\//i.test(s)) return s; // p. ej. `sha256:<hash>`
  try {
    const u = new URL(s);
    return `${u.hostname}${u.pathname}`;
  } catch {
    return s;
  }
}

/** @returns {{ mediaId: string, filename?: string, fileUrl?: string }|null} */
function mediaIdRecordado(business_phone_id, claveOUrl) {
  const k = `${business_phone_id}::${claveDeUrl(claveOUrl)}`;
  const m = mediaIds.get(k);
  if (!m) return null;
  if (Date.now() - m.en > MEDIA_ID_TTL_MS) {
    mediaIds.delete(k);
    return null;
  }
  return m.media;
}

function recordarMediaId(business_phone_id, claveOUrl, media) {
  if (!media?.mediaId) return;
  const k = `${business_phone_id}::${claveDeUrl(claveOUrl)}`;
  mediaIds.set(k, { media, en: Date.now() });
  if (mediaIds.size > MEDIA_ID_MAX) {
    mediaIds.delete(mediaIds.keys().next().value);
  }
}

module.exports = {
  hashDe,
  buscarSubida,
  registrarSubida,
  esUrlPropia,
  claveDeUrl,
  mediaIdRecordado,
  recordarMediaId,
};
