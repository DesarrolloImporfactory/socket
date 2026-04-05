// middlewares/videoConverter.js
const ffmpeg = require('fluent-ffmpeg');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

const DIR_VIDEO = path.join(__dirname, '..', 'uploads', 'productos', 'video');

async function convertirVideoWhatsApp(inputPath) {
  const outputFilename = `${uuidv4()}.mp4`;
  const outputPath = path.join(DIR_VIDEO, outputFilename);

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
