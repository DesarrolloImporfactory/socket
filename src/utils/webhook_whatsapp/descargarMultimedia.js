const axios = require('axios');
const fs = require('fs').promises;
const path = require('path');
const mime = require('mime-types');

const dominio = 'https://chat.imporfactory.app';

// Descargar y guardar audio de WhatsApp
async function descargarAudioWhatsapp(mediaId, accessToken) {
  const logsDir = path.join(process.cwd(), './src/logs/logs_meta');
  const audioDir = path.join(
    __dirname,
    '..',
    '..',
    'uploads',
    'webhook_whatsapp',
    'recibidos',
    'audios'
  );

  try {
    // Crear el directorio si no existe
    await fs.mkdir(audioDir, { recursive: true });

    // Paso 1: Obtener URL de descarga
    const mediaInfoUrl = `https://graph.facebook.com/${process.env.GRAPH_VERSION}/${mediaId}`;
    const mediaResponse = await axios.get(mediaInfoUrl, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'User-Agent': 'Mozilla/5.0',
      },
    });

    const fileUrl = mediaResponse?.data?.url;
    if (!fileUrl) {
      await logError('❌ No se obtuvo la URL del archivo de audio');
      return null;
    }

    // Paso 2: Descargar el archivo de audio binario
    const audioRes = await axios.get(fileUrl, {
      responseType: 'arraybuffer',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'User-Agent': 'Mozilla/5.0',
      },
    });

    const audioData = audioRes.data;
    // El header puede venir con parametros: 'audio/ogg; codecs=opus'
    const mimeType = (audioRes.headers['content-type'] || '')
      .split(';')[0]
      .trim()
      .toLowerCase();

    // WhatsApp no manda solo notas de voz: un audio reenviado o adjuntado como
    // archivo llega con otro MIME. Antes solo se aceptaba 'audio/ogg' y el
    // resto se descartaba en silencio (reproductor vacio, "audio en 0").
    const EXT_AUDIO = {
      'audio/ogg': 'ogg',
      'audio/opus': 'ogg',
      'audio/mpeg': 'mp3',
      'audio/mp3': 'mp3',
      'audio/mp4': 'm4a',
      'audio/x-m4a': 'm4a',
      'audio/aac': 'aac',
      'audio/amr': 'amr',
      'audio/wav': 'wav',
      'audio/x-wav': 'wav',
      'audio/webm': 'webm',
    };
    const extension = EXT_AUDIO[mimeType];
    if (!extension) {
      await logError(`❌ Tipo de archivo no válido: ${mimeType}`);
      return null;
    }
    const fileName = `${mediaId}.${extension}`;
    const fullPath = path.join(audioDir, fileName);

    // Paso 3: Guardar el archivo
    await fs.writeFile(fullPath, audioData);

    const { size } = await fs.stat(fullPath);
    await logInfo(`✅ Audio guardado: ${fullPath} (${size} bytes)`);

    // Devolver ruta relativa para guardar en DB
    return dominio + `/uploads/webhook_whatsapp/recibidos/audios/${fileName}`;
  } catch (err) {
    if (err && err.code === 'ENOSPC') {
      await logError('🔴🔴 DISCO LLENO (ENOSPC) — se esta PERDIENDO multimedia entrante. Revisar df -h YA.');
    }
    await logError(`❌ Error al descargar audio: ${err.message}`);
    return null;
  }

  async function logError(msg) {
    await fs.appendFile(
      path.join(logsDir, 'debug_log.txt'),
      `[${new Date().toISOString()}] ${msg}\n`
    );
  }

  async function logInfo(msg) {
    await fs.appendFile(
      path.join(logsDir, 'debug_log.txt'),
      `[${new Date().toISOString()}] ${msg}\n`
    );
  }
}

async function descargarImagenWhatsapp(mediaId, accessToken) {
  const logsDir = path.join(process.cwd(), './src/logs/logs_meta');
  const imageDir = path.join(
    __dirname,
    '..',
    '..',
    'uploads',
    'webhook_whatsapp',
    'recibidos',
    'imagenes'
  );

  try {
    await fs.mkdir(imageDir, { recursive: true });

    // Paso 1: obtener la URL real de descarga
    const mediaInfoUrl = `https://graph.facebook.com/${process.env.GRAPH_VERSION}/${mediaId}`;
    const mediaResponse = await axios.get(mediaInfoUrl, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'User-Agent': 'Mozilla/5.0',
      },
    });

    const fileUrl = mediaResponse?.data?.url;
    if (!fileUrl) {
      await logError('❌ No se obtuvo la URL del archivo de imagen');
      return null;
    }

    // Paso 2: descargar la imagen binaria
    const imageRes = await axios.get(fileUrl, {
      responseType: 'arraybuffer',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'User-Agent': 'Mozilla/5.0',
      },
    });

    const imageData = imageRes.data;
    const mimeType = (imageRes.headers['content-type'] || '')
      .split(';')[0].trim().toLowerCase();

    const validImageTypes = ['image/jpeg', 'image/jpg', 'image/png',
                             'image/gif', 'image/webp', 'image/bmp'];
    if (!validImageTypes.includes(mimeType)) {
      await logError(`❌ Tipo de archivo no válido: ${mimeType}`);
      return null;
    }

    const extension = mime.extension(mimeType) || 'jpg';
    const fileName = `${mediaId}.${extension}`;
    const fullPath = path.join(imageDir, fileName);

    await fs.writeFile(fullPath, imageData);

    const { size } = await fs.stat(fullPath);
    await logInfo(`✅ Imagen guardada: ${fullPath} (${size} bytes)`);

    return `${dominio}/uploads/webhook_whatsapp/recibidos/imagenes/${fileName}`;
  } catch (err) {
    if (err && err.code === 'ENOSPC') {
      await logError('🔴🔴 DISCO LLENO (ENOSPC) — se esta PERDIENDO multimedia entrante. Revisar df -h YA.');
    }
    await logError(`❌ Error al descargar imagen: ${err.message}`);
    return null;
  }

  async function logError(msg) {
    await fs.appendFile(
      path.join(logsDir, 'debug_log.txt'),
      `[${new Date().toISOString()}] ${msg}\n`
    );
  }

  async function logInfo(msg) {
    await fs.appendFile(
      path.join(logsDir, 'debug_log.txt'),
      `[${new Date().toISOString()}] ${msg}\n`
    );
  }
}

async function descargarDocumentoWhatsapp(
  mediaId,
  accessToken,
  originalFileName = null
) {
  const logsDir = path.join(process.cwd(), './src/logs/logs_meta');
  const docDir = path.join(
    __dirname,
    '..',
    '..',
    'uploads',
    'webhook_whatsapp',
    'recibidos',
    'documentos'
  );

  try {
    await fs.mkdir(docDir, { recursive: true });

    // Paso 1: obtener la URL real de descarga
    const mediaInfoUrl = `https://graph.facebook.com/${process.env.GRAPH_VERSION}/${mediaId}`;
    const mediaResponse = await axios.get(mediaInfoUrl, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'User-Agent': 'Mozilla/5.0',
      },
    });

    const fileUrl = mediaResponse?.data?.url;
    if (!fileUrl) {
      await logError('❌ No se obtuvo la URL del archivo de documento');
      return null;
    }

    // Paso 2: descargar el archivo binario
    const fileRes = await axios.get(fileUrl, {
      responseType: 'arraybuffer',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'User-Agent': 'Mozilla/5.0',
      },
    });

    const fileData = fileRes.data;

    // Paso 3: obtener la extensión del archivo
    const extensionFromUrl =
      path.extname(new URL(fileUrl).pathname).replace('.', '') || 'pdf';
    const extension =
      mime.extension(fileRes.headers['content-type']) ||
      extensionFromUrl ||
      'bin';

    // Paso 4: armar el nombre del archivo
    const fechaHora = new Date()
      .toISOString()
      .replace(/[-:T]/g, '')
      .slice(0, 15);
    const nombreBase = originalFileName || `${mediaId}.${extension}`;
    const fileName = `${fechaHora}_${nombreBase}`;
    const fullPath = path.join(docDir, fileName);

    // Paso 5: guardar el archivo
    await fs.writeFile(fullPath, fileData);
    const { size } = await fs.stat(fullPath);

    await logInfo(`✅ Documento guardado: ${fullPath} (${size} bytes)`);

    return {
      nombre: nombreBase,
      size,
      ruta: `${dominio}/uploads/webhook_whatsapp/recibidos/documentos/${fileName}`,
    };
  } catch (err) {
    if (err && err.code === 'ENOSPC') {
      await logError('🔴🔴 DISCO LLENO (ENOSPC) — se esta PERDIENDO multimedia entrante. Revisar df -h YA.');
    }
    await logError(`❌ Error al descargar documento: ${err.message}`);
    return null;
  }

  async function logError(msg) {
    await fs.appendFile(
      path.join(logsDir, 'debug_log.txt'),
      `[${new Date().toISOString()}] ${msg}\n`
    );
  }

  async function logInfo(msg) {
    await fs.appendFile(
      path.join(logsDir, 'debug_log.txt'),
      `[${new Date().toISOString()}] ${msg}\n`
    );
  }
}

async function descargarVideoWhatsapp(mediaId, accessToken) {
  const logsDir = path.join(process.cwd(), './src/logs/logs_meta');
  const videoDir = path.join(
    __dirname,
    '..',
    '..',
    'uploads',
    'webhook_whatsapp',
    'recibidos',
    'videos'
  );

  try {
    await fs.mkdir(videoDir, { recursive: true });

    // Paso 1: obtener la URL real de descarga
    const mediaInfoUrl = `https://graph.facebook.com/${process.env.GRAPH_VERSION}/${mediaId}`;
    const mediaResponse = await axios.get(mediaInfoUrl, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'User-Agent': 'Mozilla/5.0',
      },
    });

    const fileUrl = mediaResponse?.data?.url;
    if (!fileUrl) {
      await logError('❌ No se obtuvo la URL del archivo de video');
      return null;
    }

    // Paso 2: descargar el video binario
    const videoRes = await axios.get(fileUrl, {
      responseType: 'arraybuffer',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'User-Agent': 'Mozilla/5.0',
      },
    });

    const videoData = videoRes.data;
    const mimeType = (videoRes.headers['content-type'] || '')
      .split(';')[0].trim().toLowerCase();

    const validVideoTypes = ['video/mp4', 'video/avi', 'video/quicktime',
                             'video/3gpp', 'video/webm', 'video/x-matroska'];
    if (!validVideoTypes.includes(mimeType)) {
      await logError(`❌ Tipo de archivo no válido: ${mimeType}`);
      return null;
    }

    const extension = mime.extension(mimeType) || 'mp4';
    const fileName = `${mediaId}.${extension}`;
    const fullPath = path.join(videoDir, fileName);

    // Paso 3: guardar archivo
    await fs.writeFile(fullPath, videoData);
    const { size } = await fs.stat(fullPath);

    await logInfo(`✅ Video guardado: ${fullPath} (${size} bytes)`);

    return `${dominio}/uploads/webhook_whatsapp/recibidos/videos/${fileName}`;
  } catch (err) {
    if (err && err.code === 'ENOSPC') {
      await logError('🔴🔴 DISCO LLENO (ENOSPC) — se esta PERDIENDO multimedia entrante. Revisar df -h YA.');
    }
    await logError(`❌ Error al descargar video: ${err.message}`);
    return null;
  }

  async function logError(msg) {
    await fs.appendFile(
      path.join(logsDir, 'debug_log.txt'),
      `[${new Date().toISOString()}] ${msg}\n`
    );
  }

  async function logInfo(msg) {
    await fs.appendFile(
      path.join(logsDir, 'debug_log.txt'),
      `[${new Date().toISOString()}] ${msg}\n`
    );
  }
}

async function descargarStickerWhatsapp(mediaId, accessToken) {
  const logsDir = path.join(process.cwd(), './src/logs/logs_meta');
  const stickerDir = path.join(
    __dirname,
    '..',
    '..',
    'uploads',
    'webhook_whatsapp',
    'recibidos',
    'stickers'
  );

  try {
    await fs.mkdir(stickerDir, { recursive: true });

    // Paso 1: obtener la URL real
    const mediaInfoUrl = `https://graph.facebook.com/${process.env.GRAPH_VERSION}/${mediaId}`;
    const mediaResponse = await axios.get(mediaInfoUrl, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'User-Agent': 'Mozilla/5.0',
      },
    });

    const fileUrl = mediaResponse?.data?.url;
    if (!fileUrl) {
      await logError('❌ No se obtuvo la URL del archivo de sticker');
      return null;
    }

    // Paso 2: descargar el archivo binario
    const stickerRes = await axios.get(fileUrl, {
      responseType: 'arraybuffer',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'User-Agent': 'Mozilla/5.0',
      },
    });

    const stickerData = stickerRes.data;
    const mimeType = stickerRes.headers['content-type'];

    const validStickerTypes = ['image/webp'];
    if (!validStickerTypes.includes(mimeType)) {
      await logError(`❌ Tipo de archivo no válido para sticker: ${mimeType}`);
      return null;
    }

    const fileName = `${mediaId}.webp`;
    const fullPath = path.join(stickerDir, fileName);

    await fs.writeFile(fullPath, stickerData);

    const { size } = await fs.stat(fullPath);
    await logInfo(`✅ Sticker guardado: ${fullPath} (${size} bytes)`);

    return `${dominio}/uploads/webhook_whatsapp/recibidos/stickers/${fileName}`;
  } catch (err) {
    if (err && err.code === 'ENOSPC') {
      await logError('🔴🔴 DISCO LLENO (ENOSPC) — se esta PERDIENDO multimedia entrante. Revisar df -h YA.');
    }
    await logError(`❌ Error al descargar sticker: ${err.message}`);
    return null;
  }

  async function logError(msg) {
    await fs.appendFile(
      path.join(logsDir, 'debug_log.txt'),
      `[${new Date().toISOString()}] ${msg}\n`
    );
  }

  async function logInfo(msg) {
    await fs.appendFile(
      path.join(logsDir, 'debug_log.txt'),
      `[${new Date().toISOString()}] ${msg}\n`
    );
  }
}

module.exports = {
  descargarAudioWhatsapp,
  descargarImagenWhatsapp,
  descargarDocumentoWhatsapp,
  descargarVideoWhatsapp,
  descargarStickerWhatsapp,
};
