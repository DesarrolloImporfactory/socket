// middlewares/videoConverter.js
const ffmpeg = require('fluent-ffmpeg');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

const DIR_VIDEO = path.join(__dirname, '..', 'uploads', 'productos', 'video');

/**
 * Convierte cualquier video a MP4 H.264+AAC compatible con WhatsApp.
 * Retorna el nuevo filename (UUID.mp4).
 * Borra el archivo original automáticamente.
 */
async function convertirVideoWhatsApp(inputPath) {
  const outputFilename = `${uuidv4()}.mp4`;
  const outputPath = path.join(DIR_VIDEO, outputFilename);

  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .videoCodec('libx264')
      .audioCodec('aac')
      .outputOptions([
        '-preset fast',          // balance velocidad/calidad
        '-crf 28',               // calidad (18=alta, 28=buena para WA)
        '-movflags +faststart',  // metadata al inicio → streaming rápido
        '-pix_fmt yuv420p',      // compatibilidad máxima
        // forzar dimensiones pares (H.264 lo requiere)
        '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2',
      ])
      .format('mp4')
      .on('end', () => {
        // Borrar el archivo original (puede ser .mov, .avi, .webm, etc.)
        try { fs.unlinkSync(inputPath); } catch (_) {}
        resolve(outputFilename);
      })
      .on('error', (err) => {
        // Limpiar output parcial si falló
        try { if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath); } catch (_) {}
        reject(err);
      })
      .save(outputPath);
  });
}

module.exports = { convertirVideoWhatsApp };