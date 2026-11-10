'use strict';

/**
 * espiaMiniaturas.js — copia propia de la imagen de cada anuncio de ImporKiller.
 *
 * Meta firma las URL de sus imágenes (fbcdn) y las vence a los 4–5 días: el
 * parámetro `oe` trae la fecha en hexadecimal. Medido el 10-11-2026: todo
 * anuncio visto hacía más de 5 días salía sin imagen en la pantalla (403), y el
 * cliente veía recuadros vacíos. Aquí se baja la imagen mientras el enlace
 * sigue vivo, se achica (600 px de ancho, JPG) y se sube al mismo almacén que
 * usa ImporChat; `espia_anuncio.imagen_url` pasa a apuntar a esa copia, que no
 * vence. De los videos se guarda el póster; el video sigue siendo de Meta.
 *
 * Corre en segundo plano, después de responderle a la extensión: nunca frena
 * el envío de anuncios ni lo hace fallar. Si la imagen ya venció no hay nada
 * que copiar; se recupera sola la próxima vez que la extensión vea el anuncio
 * (trae un enlace fresco).
 */

const axios = require('axios');
const FormData = require('form-data');
const sharp = require('sharp');
const { QueryTypes } = require('sequelize');
const { db } = require('../database/config');

const UPLOADER_URL = process.env.UPLOADER_URL || 'https://uploader.imporfactory.app/api/files/upload';
const ANCHO = 600;
const MAX_BYTES = 12 * 1024 * 1024;
const EN_PARALELO = 3;
const TOPE_COLA = 8000;

/** ¿La URL es de Meta (vence) y no una copia nuestra? */
const esDeMeta = (url) => /(^|\.)fbcdn\.net\/|(^|\.)fbsbx\.com\/|(^|\/\/)[^/]*facebook\.com\//i.test(String(url || ''));

/** Cuándo vence un enlace de fbcdn (Date) o null si no lo dice. */
function venceEn(url) {
  const m = String(url || '').match(/[?&]oe=([0-9a-f]{6,10})/i);
  if (!m) return null;
  const t = parseInt(m[1], 16);
  return Number.isFinite(t) ? new Date(t * 1000) : null;
}

async function copiar(url) {
  const r = await axios.get(url, {
    responseType: 'arraybuffer',
    timeout: 25000,
    maxContentLength: MAX_BYTES,
    validateStatus: (s) => s === 200,
  });
  const jpg = await sharp(Buffer.from(r.data))
    .rotate()
    .resize({ width: ANCHO, withoutEnlargement: true })
    .jpeg({ quality: 74, mozjpeg: true })
    .toBuffer();
  const form = new FormData();
  form.append('file', jpg, { filename: 'anuncio.jpg', contentType: 'image/jpeg' });
  const s = await axios.post(UPLOADER_URL, form, {
    headers: form.getHeaders(),
    timeout: 60000,
    maxContentLength: 20 * 1024 * 1024,
    maxBodyLength: 20 * 1024 * 1024,
  });
  const propia = s.data?.data?.url;
  if (typeof propia !== 'string' || !/^https:\/\/\S+$/i.test(propia) || esDeMeta(propia)) {
    throw new Error('el almacén no devolvió una URL');
  }
  return propia;
}

/**
 * Copia la imagen de un anuncio y actualiza la fila. → 'ok' | 'vencida' | 'error' | 'nada'
 * El UPDATE exige que la fila siga teniendo la misma URL de Meta: si entre tanto
 * llegó otra (o ya se copió), no se pisa.
 */
async function procesar(adId, url) {
  if (!url || !esDeMeta(url)) return 'nada';
  const vence = venceEn(url);
  if (vence && vence.getTime() < Date.now()) return 'vencida';
  try {
    const propia = await copiar(url);
    await db.query(
      `UPDATE espia_anuncio SET imagen_url = :propia WHERE ad_archive_id = :id AND imagen_url = :url`,
      { replacements: { propia, id: String(adId), url }, type: QueryTypes.UPDATE },
    );
    return 'ok';
  } catch (e) {
    return e?.response?.status === 403 || e?.response?.status === 404 ? 'vencida' : 'error';
  }
}

/* ── Cola en memoria (segundo plano) ─────────────────────────────────── */
const cola = [];
const enCola = new Set();
let activos = 0;

function bombear() {
  while (activos < EN_PARALELO && cola.length) {
    const id = cola.shift();
    activos += 1;
    (async () => {
      try {
        const [fila] = await db.query(`SELECT imagen_url FROM espia_anuncio WHERE ad_archive_id = :id`, {
          replacements: { id },
          type: QueryTypes.SELECT,
        });
        if (fila) await procesar(id, fila.imagen_url);
      } catch {
        /* se reintenta la próxima vez que la extensión vea el anuncio */
      } finally {
        enCola.delete(id);
        activos -= 1;
        bombear();
      }
    })();
  }
}

/** Encola anuncios recién recibidos. No espera ni lanza. */
function encolar(ids = []) {
  for (const crudo of ids) {
    const id = String(crudo || '');
    if (!id || enCola.has(id) || cola.length >= TOPE_COLA) continue;
    enCola.add(id);
    cola.push(id);
  }
  bombear();
}

/**
 * Pone al día lo que quedó con enlace de Meta (los más recientes primero).
 * Para el script: espera a terminar y devuelve el conteo.
 */
async function ponerAlDia({ limite = 500, log = () => {} } = {}) {
  const filas = await db.query(
    `SELECT ad_archive_id, imagen_url FROM espia_anuncio
      WHERE imagen_url LIKE '%fbcdn.net/%' ORDER BY ultima_vez_visto DESC LIMIT :limite`,
    { replacements: { limite: Math.max(1, Number(limite) || 500) }, type: QueryTypes.SELECT },
  );
  const r = { revisados: filas.length, ok: 0, vencida: 0, error: 0, nada: 0 };
  let i = 0;
  const trabajador = async () => {
    while (i < filas.length) {
      const f = filas[i++];
      r[await procesar(f.ad_archive_id, f.imagen_url)] += 1;
      const hechos = r.ok + r.vencida + r.error + r.nada;
      if (hechos % 100 === 0) log(`… ${hechos}/${filas.length} · copiadas ${r.ok} · vencidas ${r.vencida} · con error ${r.error}`);
    }
  };
  await Promise.all(Array.from({ length: EN_PARALELO }, trabajador));
  return r;
}

module.exports = { esDeMeta, venceEn, encolar, ponerAlDia, procesar };
