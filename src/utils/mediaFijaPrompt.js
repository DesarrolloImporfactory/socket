/* ═══════════════════════════════════════════════════════════
   Media fija del prompt: cada video/imagen va con SU plantilla

   En un bot de soporte (cfg 261) los videos tutoriales están escritos en el
   propio prompt, cada uno pegado a su respuesta:

       [producto_video_url]: https://…/stream/3f43…
       📦 Para agilizar el proceso, así revisas el estado de tu paquete:
       1. Ingresa a este link: …

   El modelo a veces escribe la etiqueta y NO la plantilla: al cliente le
   llegaba el video del catálogo junto a "ya un asesor revisa tu caso", sin el
   link ni los pasos (cfg 261, 2026-10-02). Acá se resuelve con datos, no
   pidiéndoselo otra vez al modelo:

   - `plantillasFijas(prompt)` lee del prompt qué plantilla acompaña a cada
     URL (la primera línea que sigue a la etiqueta es su "ancla").
   - `separarMediaFija` descarta la media fija cuya plantilla no viene en la
     respuesta. La media que NO está en el prompt (fotos del catálogo) no se
     toca.
   - `plantillasEnviadas` dice cuáles ya recibió el cliente en las últimas N
     horas, para avisárselo al modelo antes de que conteste (regla "no
     repetir la misma plantilla": tres rastreos seguidos a la misma persona, cfg 261).

   Se prenden por cuenta desde la acción enviar_media de la columna:
   { fijos_con_plantilla: true, fijos_no_repetir_horas: 24 }.
   ═══════════════════════════════════════════════════════════ */
const { db } = require('../database/config');

const RE_ETIQUETA =
  /^\s*\[producto_(?:video|imagen)_url\]:\s*(https?:\/\/\S+)\s*$/i;

/* Con qué se compara: sin emojis, tildes ni signos, y solo el arranque —el
   modelo ajusta el final de la frase ("…el estado de tu paquete 189852073:")
   pero el arranque de un texto aprobado lo copia. */
const LARGO_ANCLA = 28;
function normalizar(texto) {
  return String(texto || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** url → { ancla, anclaNorm } según la PRIMERA aparición de la etiqueta. */
function plantillasFijas(prompt) {
  const out = new Map();
  const lineas = String(prompt || '').split(/\r?\n/);
  for (let i = 0; i < lineas.length; i++) {
    const m = lineas[i].match(RE_ETIQUETA);
    if (!m || out.has(m[1])) continue;
    // La plantilla es la primera línea con texto que no sea otra etiqueta.
    for (let j = i + 1; j < lineas.length && j <= i + 4; j++) {
      const sig = lineas[j].trim();
      if (!sig || RE_ETIQUETA.test(sig)) continue;
      const anclaNorm = normalizar(sig).slice(0, LARGO_ANCLA).trim();
      if (anclaNorm.length >= 12) out.set(m[1], { ancla: sig, anclaNorm });
      break;
    }
  }
  return out;
}

/**
 * Separa la media que puede salir de la que quedó huérfana de su plantilla.
 * @returns {{ conservar: string[], descartar: string[] }}
 */
function separarMediaFija({ urls, texto, prompt }) {
  const fijas = plantillasFijas(prompt);
  const textoNorm = normalizar(texto);
  const conservar = [];
  const descartar = [];
  for (const url of urls || []) {
    const fija = fijas.get(url);
    if (fija && !textoNorm.includes(fija.anclaNorm)) descartar.push(url);
    else conservar.push(url);
  }
  return { conservar, descartar };
}

/** Anclas de las plantillas cuya media ya le llegó al cliente en `horas`. */
async function plantillasEnviadas({ id_cliente, id_configuracion, prompt, horas }) {
  const fijas = plantillasFijas(prompt);
  const h = Number(horas);
  if (!fijas.size || !Number.isFinite(h) || h <= 0) return [];
  const filas = await db.query(
    `SELECT DISTINCT ruta_archivo FROM mensajes_clientes
      WHERE celular_recibe = ? AND id_configuracion = ?
        AND rol_mensaje = 1 AND deleted_at IS NULL
        AND ruta_archivo IN (?)
        AND created_at >= NOW() - INTERVAL ? HOUR`,
    {
      replacements: [
        String(id_cliente),
        id_configuracion,
        [...fijas.keys()],
        Math.min(h, 72),
      ],
      type: db.QueryTypes.SELECT,
    },
  );
  return filas.map((f) => fijas.get(f.ruta_archivo)?.ancla).filter(Boolean);
}

module.exports = { plantillasFijas, separarMediaFija, plantillasEnviadas, normalizar };
