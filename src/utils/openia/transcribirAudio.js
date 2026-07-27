// utils/openia/transcribirAudio.js
// Convierte las notas de voz que envía el cliente en texto, para que la IA del
// kanban pueda "escucharlas".
//
// Es el gemelo de describirImagen.js: el audio se vuelve texto y entra al
// pipeline como si el cliente lo hubiera escrito. Así no hay que tocar
// kanban_ia.service.js ni los prompts de los asistentes.
//
// Dos entradas según el canal:
//   - transcribirAudioDesdeArchivo(rutaPublica)     → WhatsApp (archivo local)
//   - transcribirAudioDesdeUrl(url, key, canal)     → Instagram / Messenger (CDN Meta)
//
// Antes esto vivía triplicado (funcciones_asistente.js, instagram.service.js y
// messenger.service.js) con implementaciones que se fueron desincronizando: a
// las tres les faltaba el timeout, y a las de IG/MS el límite de tamaño y la
// extensión real del archivo. Unificado, cada arreglo se hace una sola vez.
// ─────────────────────────────────────────────────────────────

const axios = require('axios');
const fs = require('fs').promises;
const fsSync = require('fs'); // para createReadStream
const path = require('path');
const FormData = require('form-data');

const DOMINIO_PUBLICO = 'https://chat.imporfactory.app';
const MODELO = 'gpt-4o-transcribe';
const IDIOMA = 'es'; // el mercado es EC/CO/MX/GT; forzarlo mejora la precisión

// OpenAI rechaza audios de más de 25 MB. Cortamos antes para no gastar memoria
// ni ancho de banda en algo que va a fallar igual.
const MAX_BYTES = 24 * 1024 * 1024;

// Timeout de la llamada a OpenAI. NO es opcional: esto corre dentro del webhook
// de Meta, así que si OpenAI se cuelga, Meta no recibe el 200, reintenta el
// webhook y terminamos procesando —y pagando— el mismo audio dos veces.
const TIMEOUT_OPENAI_MS = 60000;

// Timeout de la descarga desde el CDN de Meta.
const TIMEOUT_DESCARGA_MS = 30000;

// Lo que recibe la IA cuando el audio no se pudo transcribir. Es preferible
// decirle explícitamente qué pasó (para que le pida al cliente que escriba) a
// dejarla sin mensaje: sin esto respondía cualquier cosa o no respondía nada.
const TEXTO_AUDIO_ILEGIBLE =
  '[El cliente envió un audio que no se pudo transcribir]';

// Contexto que se le pasa a la transcripción para que entienda la jerga.
const CONTEXTO_POR_CANAL = {
  WA: 'Audio de WhatsApp en español. Conversación informal entre cliente y empresa.',
  IG: 'Audio de Instagram en español. Conversación informal entre cliente y empresa.',
  MS: 'Audio de Messenger en español. Conversación informal entre cliente y empresa.',
};

// OpenAI deduce el formato del audio por la EXTENSIÓN del nombre de archivo, no
// por el contenido. Mandar una extensión que no corresponde al contenedor real
// termina en `400 Invalid file format`, y antes la extensión estaba fija en
// '.mp4' aunque Meta sirviera otra cosa.
// Formatos aceptados por la API: flac, m4a, mp3, mp4, mpeg, mpga, oga, ogg, wav, webm.
const EXT_POR_MIME = {
  'audio/ogg': 'ogg',
  'audio/oga': 'oga',
  'audio/opus': 'ogg',
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/mp4': 'm4a',
  'audio/m4a': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/webm': 'webm',
  'audio/flac': 'flac',
  'audio/x-flac': 'flac',
};

function mimeLimpio(contentType) {
  return String(contentType || '')
    .split(';')[0]
    .trim()
    .toLowerCase();
}

// ══════════════════════════════════════════════════════════════
// Log de fallos
//
// Todo fallo se escribe en el MISMO debug_log.txt que ya usa el webhook, para
// poder rastrear después qué audio no se pudo transcribir y por qué. La consola
// sola no alcanzaba: en producción se pierde.
//
// `ref` es el identificador del mensaje (wamid en WhatsApp, mid en IG/MS). Sin
// él el log dice que algo falló pero no cuál, que era justamente el problema.
// ══════════════════════════════════════════════════════════════
const LOGS_DIR = path.join(process.cwd(), 'src', 'logs', 'logs_meta');

async function avisarFallo(etiqueta, detalle, ref) {
  const linea = `[${etiqueta}][ERROR]${ref ? ` (ref=${ref})` : ''} ${detalle}`;
  console.log(linea);
  try {
    await fs.mkdir(LOGS_DIR, { recursive: true });
    await fs.appendFile(
      path.join(LOGS_DIR, 'debug_log.txt'),
      `[${new Date().toISOString()}] 🎙️ ${linea}\n`,
    );
  } catch (_) {
    // Si no se puede escribir el log, no rompemos la transcripción.
  }
}

// ══════════════════════════════════════════════════════════════
// Llamada única a OpenAI. Recibe el FormData con el archivo ya cargado.
// ══════════════════════════════════════════════════════════════
async function pedirTranscripcion(form, apiKeyOpenAI, etiquetaLog, contexto, ref) {
  form.append('model', MODELO);
  form.append('language', IDIOMA);
  // Los modelos nuevos sólo soportan json o text (no srt/vtt).
  form.append('response_format', 'json');
  form.append('prompt', contexto);

  const res = await axios.post(
    'https://api.openai.com/v1/audio/transcriptions',
    form,
    {
      headers: {
        Authorization: `Bearer ${apiKeyOpenAI}`,
        ...form.getHeaders(),
      },
      timeout: TIMEOUT_OPENAI_MS,
      maxBodyLength: Infinity, // el archivo puede pesar varios MB
    },
  );

  const texto = String(res.data?.text || '').trim();
  if (!texto) {
    // Pasa con audios de puro silencio o ruido.
    await avisarFallo(etiquetaLog, 'transcripción vacía', ref);
    return null;
  }
  return texto;
}

// ══════════════════════════════════════════════════════════════
// WhatsApp: el audio ya fue descargado por descargarAudioWhatsapp y vive en
// src/uploads/... Se lee del disco (no por URL) porque en desarrollo el archivo
// es local pero la URL guardada apunta a producción.
// ══════════════════════════════════════════════════════════════
async function transcribirAudioDesdeArchivo(rutaArchivo, apiKeyOpenAI, ref) {
  try {
    if (!rutaArchivo || !apiKeyOpenAI) return null;

    const rutaRelativa = String(rutaArchivo).replace(DOMINIO_PUBLICO, '');
    // __dirname = <raiz>/src/utils/openia → '..','..' deja <raiz>/src, que es
    // donde vive la carpeta uploads (igual que en describirImagen.js).
    const rutaAbsoluta = path.join(__dirname, '..', '..', rutaRelativa);

    // Si el archivo no existe, stat lanza ENOENT y cae al catch con un mensaje
    // claro. Antes el error se veía igual pero sin decir qué ruta falló.
    const stat = await fs.stat(rutaAbsoluta);

    if (!stat.size) {
      await avisarFallo('WHISPER][WA', `archivo vacío: ${rutaAbsoluta}`, ref);
      return null;
    }
    if (stat.size > MAX_BYTES) {
      await avisarFallo(
        'WHISPER][WA',
        `audio demasiado grande (${stat.size} bytes, máx ${MAX_BYTES})`,
        ref,
      );
      return null;
    }

    const form = new FormData();
    // form-data toma el filename del path del stream (<mediaId>.ogg), que es la
    // extensión real con la que lo guardó descargarAudioWhatsapp.
    form.append('file', fsSync.createReadStream(rutaAbsoluta), {
      knownLength: stat.size,
    });

    return await pedirTranscripcion(
      form,
      apiKeyOpenAI,
      'WHISPER][WA',
      CONTEXTO_POR_CANAL.WA,
      ref,
    );
  } catch (err) {
    await avisarFallo(
      'WHISPER][WA',
      err?.response?.data?.error?.message || err.message,
      ref,
    );
    return null;
  }
}

// ══════════════════════════════════════════════════════════════
// Instagram / Messenger: el audio vive en el CDN de Meta. Se descarga a memoria
// y se reenvía, porque la URL de Meta es firmada y expira (OpenAI no podría
// alcanzarla por su cuenta).
// ══════════════════════════════════════════════════════════════
async function transcribirAudioDesdeUrl(url, apiKeyOpenAI, canal = 'IG', ref) {
  const etiqueta = `WHISPER][${canal}`;
  try {
    if (!url || !apiKeyOpenAI) return null;

    const audioRes = await axios.get(url, {
      responseType: 'arraybuffer',
      timeout: TIMEOUT_DESCARGA_MS,
      maxContentLength: MAX_BYTES, // antes no había tope: entraba todo a memoria
    });

    const mime = mimeLimpio(audioRes.headers['content-type']);

    // Los adjuntos de tipo 'audio' de Meta deberían venir como audio/*, pero si
    // llega otra cosa (un video, un HTML de error del CDN) es mejor cortar acá
    // que pagarle a OpenAI para que lo rechace.
    if (mime && !mime.startsWith('audio/')) {
      await avisarFallo(etiqueta, `el adjunto no es audio (${mime})`, ref);
      return null;
    }

    // Si Meta no manda un content-type reconocible, caemos a 'mp4', que es lo
    // que se usaba fijo antes y con lo que las notas de voz vienen funcionando.
    const ext = EXT_POR_MIME[mime] || 'mp4';

    const form = new FormData();
    form.append('file', Buffer.from(audioRes.data), {
      filename: `audio_${String(canal).toLowerCase()}.${ext}`,
      ...(mime ? { contentType: mime } : {}),
    });

    return await pedirTranscripcion(
      form,
      apiKeyOpenAI,
      etiqueta,
      CONTEXTO_POR_CANAL[canal] || CONTEXTO_POR_CANAL.IG,
      ref,
    );
  } catch (err) {
    await avisarFallo(
      etiqueta,
      err?.response?.data?.error?.message || err.message,
      ref,
    );
    return null;
  }
}

module.exports = {
  transcribirAudioDesdeArchivo,
  transcribirAudioDesdeUrl,
  TEXTO_AUDIO_ILEGIBLE,
};
