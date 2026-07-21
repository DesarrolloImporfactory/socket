// middlewares/videoConverter.js
const ffmpeg = require('fluent-ffmpeg');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

const DIR_VIDEO = path.join(__dirname, '..', 'uploads', 'productos', 'video');

/**
 * ¿El video YA cumple lo que exige WhatsApp? (MP4 + H.264 + audio AAC + yuv420p,
 * que es justo lo que fuerza la conversión de abajo). Si ya cumple, re-encodear
 * solo degrada la calidad y quema CPU para nada.
 *
 * CONSERVADOR: ante cualquier error de ffprobe devuelve false, de modo que se
 * convierta igual. Nunca deja pasar un video dudoso.
 */
function videoYaCompatible(inputPath) {
  return new Promise((resolve) => {
    ffmpeg.ffprobe(inputPath, (err, data) => {
      if (err || !data) return resolve(false);

      const streams = Array.isArray(data.streams) ? data.streams : [];
      const video = streams.find((s) => s.codec_type === 'video');
      const audio = streams.find((s) => s.codec_type === 'audio');

      const esMp4 = /mp4|m4a|isom/i.test(String(data.format?.format_name || ''));
      const esH264 = String(video?.codec_name || '').toLowerCase() === 'h264';
      const audioOk = String(audio?.codec_name || '').toLowerCase() === 'aac';
      const pixOk = String(video?.pix_fmt || '') === 'yuv420p';

      resolve(esMp4 && esH264 && audioOk && pixOk);
    });
  });
}

async function convertirVideoWhatsApp(inputPath) {
  const outputFilename = `${uuidv4()}.mp4`;
  const outputPath = path.join(DIR_VIDEO, outputFilename);

  // ── Corto-circuito: ya es compatible → mover al destino SIN re-encodear ──
  if (await videoYaCompatible(inputPath)) {
    console.log(
      '🎬 [VIDEO_CONVERT] Ya es compatible (mp4/h264/aac/yuv420p): se reutiliza SIN re-encodear.',
    );
    await fs.promises.mkdir(DIR_VIDEO, { recursive: true });
    try {
      await fs.promises.rename(inputPath, outputPath);
    } catch (_) {
      // rename falla si origen y destino están en volúmenes distintos
      await fs.promises.copyFile(inputPath, outputPath);
      await fs.promises.unlink(inputPath).catch(() => {});
    }
    return outputFilename;
  }

  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .videoCodec('libx264')
      .audioCodec('aac')
      .outputOptions([
        '-preset ultrafast', // ← ultrafast en vez de fast, mucho más rápido
        '-crf 30',
        '-movflags +faststart',
        '-pix_fmt yuv420p',
        '-vf',
        'scale=trunc(iw/2)*2:trunc(ih/2)*2',
      ])
      .format('mp4')
      .on('end', () => {
        try {
          fs.unlinkSync(inputPath);
        } catch (_) {}
        resolve(outputFilename);
      })
      .on('error', (err) => {
        try {
          if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
        } catch (_) {}
        reject(err);
      })
      .save(outputPath);
  });
}

/**
 * Convierte en background y actualiza la BD cuando termina.
 * El request ya respondió antes de llamar esto.
 */
async function convertirVideoEnBackground(
  inputPath,
  productoId,
  dominio,
  ProductoModel,
) {
  try {
    console.log(
      `🎬 Iniciando conversión background para producto #${productoId}`,
    );
    const convertedFilename = await convertirVideoWhatsApp(inputPath);
    const newUrl = `${dominio}/uploads/productos/video/${convertedFilename}`;
    await ProductoModel.update(
      { video_url: newUrl },
      { where: { id: productoId } },
    );
    console.log(
      `✅ Video convertido y actualizado en BD — producto #${productoId}`,
    );
  } catch (err) {
    console.error(
      `❌ Error conversión background producto #${productoId}:`,
      err.message,
    );
  }
}

module.exports = { convertirVideoWhatsApp, convertirVideoEnBackground };
