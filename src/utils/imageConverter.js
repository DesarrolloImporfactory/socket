const fs = require('fs').promises;
const path = require('path');
const axios = require('axios');
const sharp = require('sharp');
const { uploadToUploader } = require('./whatsappTemplate.helpers');

const META_IMAGE_MAX_BYTES = 5 * 1024 * 1024; // 5 MB (límite Meta para IMAGE)

/**
 * Convierte un buffer de imagen a JPG optimizado para WhatsApp.
 * Reintenta con más compresión si supera 5MB.
 */
async function sharpToJpg(sourceBuffer) {
  let out = await sharp(sourceBuffer)
    .rotate() // respeta EXIF orientation
    .resize({ width: 1200, withoutEnlargement: true })
    .flatten({ background: '#ffffff' }) // fondo blanco si hay transparencia
    .jpeg({ quality: 85, mozjpeg: true })
    .toBuffer();

  if (out.length > META_IMAGE_MAX_BYTES) {
    console.warn(
      `[IMG_CONVERT] Imagen supera 5MB (${(out.length / 1024 / 1024).toFixed(2)}MB), recomprimiendo...`,
    );

    out = await sharp(sourceBuffer)
      .rotate()
      .resize({ width: 1000, withoutEnlargement: true })
      .flatten({ background: '#ffffff' })
      .jpeg({ quality: 70, mozjpeg: true })
      .toBuffer();

    if (out.length > META_IMAGE_MAX_BYTES) {
      console.warn(
        `[IMG_CONVERT] Imagen sigue excediendo 5MB tras recomprimir (${(out.length / 1024 / 1024).toFixed(2)}MB)`,
      );
      // Seguimos igual — Meta podría rechazarla, pero es raro
    }
  }

  return out;
}

/**
 * CASO A: Uploads manuales (multer diskStorage).
 * Lee el archivo que multer ya guardó, lo convierte a JPG en el mismo
 * directorio, y borra el original si cambió la extensión.
 *
 * @param {string} absPath  Ruta absoluta al archivo que dejó multer
 * @returns {Promise<string>} Nuevo filename (solo basename, ej: "foto-123.jpg")
 */
async function convertLocalFileToJpg(absPath) {
  const buffer = await fs.readFile(absPath);
  const jpgBuffer = await sharpToJpg(buffer);

  const dir = path.dirname(absPath);
  const base = path.basename(absPath, path.extname(absPath));
  const newPath = path.join(dir, `${base}.jpg`);

  await fs.writeFile(newPath, jpgBuffer);

  // Borra original si la extensión cambió (webp, png, heic, etc.)
  if (newPath !== absPath) {
    await fs.unlink(absPath).catch(() => {});
  }

  return path.basename(newPath);
}

/**
 * CASO B: URLs externas (Dropi, carga masiva Excel).
 * Descarga la imagen desde la URL → convierte a JPG → sube a S3.
 *
 * @param {string} sourceUrl  URL original (webp, png, jpg...)
 * @param {string|number} idForName  Sufijo identificador para el nombre
 * @param {string} folder  Carpeta lógica en S3
 * @returns {Promise<string|null>} URL final en S3, o null si falla
 */
async function downloadAndConvertToJpgS3(
  sourceUrl,
  idForName,
  folder = 'productos/externos',
) {
  if (!sourceUrl) return null;

  try {
    // 1) Descargar imagen original
    const response = await axios.get(sourceUrl, {
      responseType: 'arraybuffer',
      timeout: 20000,
      maxContentLength: 25 * 1024 * 1024,
      headers: { 'User-Agent': 'Mozilla/5.0' },
    });

    // 2) Convertir a JPG
    const jpgBuffer = await sharpToJpg(response.data);

    // 3) Subir a S3
    const filename = `img-${idForName}-${Date.now()}.jpg`;
    const { fileUrl } = await uploadToUploader({
      buffer: jpgBuffer,
      originalname: filename,
      mimetype: 'image/jpeg',
      folder,
    });

    return fileUrl || null;
  } catch (err) {
    console.error(
      `⚠️ [IMG_CONVERT] Error procesando ${sourceUrl}: ${err.message}`,
    );
    return null;
  }
}

module.exports = {
  convertLocalFileToJpg,
  downloadAndConvertToJpgS3,
};
