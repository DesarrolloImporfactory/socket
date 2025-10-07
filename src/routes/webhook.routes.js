const express = require('express');
const { upload } = require('../utils/multer');
const { webhook } = require('../controllers/chat.controller');
const ffmpeg = require('fluent-ffmpeg');
const axios = require('axios');
const fs = require('fs').promises;
const path = require('path');
ffmpeg.setFfmpegPath('/usr/bin/ffmpeg');
const router = express.Router();

router.get('/', async (req, res) => {
  try {
    return res.status(200).json({ message: 'Webhook working!' });
  } catch (error) {}
});

router.post('/webhook', webhook);

router.post('/upload', upload.single('audio'), async (req, res) => {
  try {
    if (!req.file) {
      return res
        .status(400)
        .json({ error: 'No se ha proporcionado ningún archivo' });
    }

    const inputFilePath = path.join(
      __dirname,
      '../uploads/audios',
      req.file.filename
    );
    const outputFilePath = path.join(
      __dirname,
      '../uploads/audios',
      `${Date.now()}-${req.file.originalname}`
    );

    // Usa ffmpeg para convertir a OGG Opus
    ffmpeg(inputFilePath)
      .audioBitrate(128)
      .audioCodec('libopus') // Codec Opus
      .format('ogg')
      .on('end', async () => {
        try {
          // Elimina el archivo original después de la conversión si es necesario
          await fs.unlink(inputFilePath);

          // Lee el archivo convertido y envíalo al cliente
          const data = await fs.readFile(outputFilePath);

          // Borra el archivo convertido después de leerlo si es necesario
          await fs.unlink(outputFilePath);

          // Devuelve el archivo como respuesta en formato binario
          res.status(200).json({
            message: 'Archivo convertido y listo para enviar',
            file: data.toString('base64'), // Lo convierte a Base64 para enviar en JSON
          });
        } catch (err) {
          console.error('Error al eliminar o leer los archivos:', err);
          res
            .status(500)
            .json({ error: 'Error al eliminar o leer los archivos' });
        }
      })
      .on('error', (err) => {
        console.error('Error en la conversión:', err);
        res.status(500).json({ error: 'Error en la conversión del archivo' });
      })
      .save(outputFilePath); // Guarda el archivo convertido
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
});

router.post('/guardar_audio', async (req, res) => {
  const { mediaId, accessToken } = req.body; // Datos que deberías recibir en el cuerpo de la solicitud
  const audioDir = path.join(
    __dirname,
    '..',
    '..',
    'uploads',
    'webhook_whatsapp',
    'enviados',
    'audios'
  );

  try {
    // Crear el directorio si no existe
    await fs.mkdir(audioDir, { recursive: true });

    // Paso 1: Obtener URL de descarga del archivo
    const mediaInfoUrl = `https://graph.facebook.com/v19.0/${mediaId}`;
    const mediaResponse = await axios.get(mediaInfoUrl, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'User-Agent': 'Mozilla/5.0',
      },
    });

    const fileUrl = mediaResponse?.data?.url;
    if (!fileUrl) {
      return res
        .status(500)
        .json({ error: 'No se obtuvo la URL del archivo de audio' });
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
    const mimeType = audioRes.headers['content-type'];

    // Verificar si el tipo MIME es 'audio/ogg'
    if (mimeType !== 'audio/ogg') {
      return res.status(400).json({ error: 'Tipo de archivo no válido' });
    }

    // Forzamos la extensión a .ogg
    const extension = 'ogg';
    const fileName = `${mediaId}.${extension}`;
    const fullPath = path.join(audioDir, fileName);

    // Paso 3: Guardar el archivo
    await fs.writeFile(fullPath, audioData);

    const { size } = await fs.stat(fullPath);

    // Devolver la ruta relativa para guardar en la DB
    return res.status(200).json({
      message: 'Audio guardado correctamente',
      fileUrl: `https://chat.imporfactory.app/uploads/webhook_whatsapp/enviados/audios/${fileName}`,
    });
  } catch (err) {
    return res.status(500).json({ error: 'Error al guardar el audio enviado' });
  }
});

module.exports = router;
