const fs = require('fs');
const os = require('os');
const path = require('path');
const axios = require('axios');
const FormData = require('form-data');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

/*  Nota de voz grabada en Team (Chrome graba webm/opus; Safari, mp4/aac).
 *  Se pasa a ogg/opus y se sube al mismo almacén que usa ImporChat para que
 *  ChatService.sendMessage la mande a WhatsApp como nota de voz (voice: true)
 *  y quede reproducible en el historial. */

const MAX_SEGUNDOS = 300;
const MIN_SEGUNDOS = 0.5;
const UPLOADER_URL = process.env.UPLOADER_URL || 'https://uploader.imporfactory.app/api/files/upload';

/*  buffer (webm/mp4/ogg…) → { ogg, segundos }. Mismos parámetros de voz que
 *  chat.service, recortado a MAX_SEGUNDOS y sin metadatos del teléfono. */
async function convertirAOggOpus(buffer) {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'nota-voz-'));
  const entrada = path.join(dir, 'entrada');
  const salida = path.join(dir, 'salida.ogg');
  try {
    await fs.promises.writeFile(entrada, buffer);
    const { stderr } = await execFileAsync(
      'ffmpeg',
      [
        '-hide_banner', '-nostdin', '-y',
        '-i', entrada,
        '-t', String(MAX_SEGUNDOS),
        '-vn', '-map_metadata', '-1',
        '-c:a', 'libopus', '-ar', '16000', '-ac', '1', '-b:a', '16k',
        '-application', 'voip', '-frame_duration', '20',
        '-f', 'ogg', salida,
      ],
      { timeout: 60000, maxBuffer: 4 * 1024 * 1024 },
    );
    const ogg = await fs.promises.readFile(salida);
    if (!ogg || ogg.length < 100) throw new Error('ogg vacío');
    // La última «time=HH:MM:SS.xx» del progreso es lo que duró la salida.
    const tiempos = [...String(stderr || '').matchAll(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/g)];
    const t = tiempos.length ? tiempos[tiempos.length - 1] : null;
    const segundos = t ? Number(t[1]) * 3600 + Number(t[2]) * 60 + Number(t[3]) : null;
    return { ogg, segundos };
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/*  Sube el ogg y devuelve su URL pública. Nombre sin cifras: la URL pasa por
 *  taparTelefonos y no debe parecer un número. */
async function subirAlUploader(ogg) {
  const form = new FormData();
  form.append('file', ogg, { filename: 'nota-voz.ogg', contentType: 'audio/ogg' });
  const r = await axios.post(UPLOADER_URL, form, {
    headers: form.getHeaders(),
    timeout: 60000,
    maxContentLength: 20 * 1024 * 1024,
    maxBodyLength: 20 * 1024 * 1024,
  });
  const url = r.data?.data?.url;
  if (typeof url !== 'string' || !/^https:\/\/[^\s]+\.ogg$/i.test(url)) {
    throw new Error('el almacén no devolvió una URL .ogg');
  }
  return url;
}

module.exports = { convertirAOggOpus, subirAlUploader, MAX_SEGUNDOS, MIN_SEGUNDOS };
