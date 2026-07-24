// utils/rehostMediaMeta.js
// -----------------------------------------------------------------------------
// Descarga la media entrante de Instagram/Messenger (URLs del CDN de Meta,
// scontent.xx.fbcdn.net / lookaside.fbsbx.com — FIRMADAS y que EXPIRAN) y la
// re-hospeda en nuestro dominio, igual que hace WhatsApp con su media. Así las
// imágenes/videos/audios cargan siempre en el chat, sin depender de la URL
// temporal de Meta.
//
// La media de IG/MS ya llega con una URL pública en el webhook, así que solo hay
// que descargarla y guardarla (no requiere el paso de /media con token como WA).
// -----------------------------------------------------------------------------

const axios = require('axios');
const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const mime = require('mime-types');

const DOMINIO = 'https://chat.imporfactory.app';
const SUBDIR = 'social_recibidos';
const DIR_ABS = path.join(__dirname, '..', 'uploads', SUBDIR); // src/uploads/social_recibidos

const TIPOS_MEDIA = new Set(['image', 'video', 'audio', 'file', 'sticker']);

const EXT_FALLBACK = {
  image: 'jpg',
  video: 'mp4',
  audio: 'mp4',
  sticker: 'png',
  file: 'bin',
};

// Solo re-hospedamos URLs externas (Meta); las que ya están en nuestro dominio
// (p.ej. media saliente de la IA) se dejan tal cual.
function esUrlExterna(url) {
  return /^https?:\/\//i.test(url) && !/chat\.imporfactory\.app/i.test(url);
}

async function descargarYReHospedar(url, tipo) {
  try {
    const res = await axios.get(url, {
      responseType: 'arraybuffer',
      timeout: 30000,
      headers: { 'User-Agent': 'Mozilla/5.0' },
    });

    const ct = res.headers['content-type'] || '';
    let ext = mime.extension(ct) || EXT_FALLBACK[tipo] || 'bin';
    if (ext === 'jpeg') ext = 'jpg';

    const fileName = `${crypto.randomUUID()}.${ext}`;
    await fs.mkdir(DIR_ABS, { recursive: true });
    await fs.writeFile(path.join(DIR_ABS, fileName), Buffer.from(res.data));

    return `${DOMINIO}/uploads/${SUBDIR}/${fileName}`;
  } catch (err) {
    console.error(
      '[REHOST_MEDIA][ERROR]',
      err.response?.status || err.message,
    );
    return null;
  }
}

/**
 * Recibe un arreglo de attachments (formato unificado de IG o crudo de MS:
 * { type, payload: { url } }) y devuelve un NUEVO arreglo con las URLs de media
 * re-hospedadas en nuestro dominio. Si una descarga falla, deja ese attachment
 * con su URL original (degrada, no rompe). No lanza.
 */
async function rehostAttachments(attachments) {
  if (!Array.isArray(attachments) || !attachments.length) return attachments;

  const out = [];
  for (const a of attachments) {
    try {
      const url = a?.payload?.url;
      const tipo = String(a?.type || '').toLowerCase();

      if (url && TIPOS_MEDIA.has(tipo) && esUrlExterna(url)) {
        const nueva = await descargarYReHospedar(url, tipo);
        if (nueva) {
          out.push({
            ...a,
            payload: { ...a.payload, url: nueva, url_original: url },
          });
          continue;
        }
      }
    } catch (_) {
      /* deja el attachment original */
    }
    out.push(a);
  }
  return out;
}

module.exports = { rehostAttachments, descargarYReHospedar };
