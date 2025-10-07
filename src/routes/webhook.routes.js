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

router.post('/guardar_audio', upload.single('audio'), async (req, res) => {
  if (!req.file) {
    console.error('❌ Error: No se ha proporcionado ningún archivo');
    return res
      .status(400)
      .json({ error: 'No se ha proporcionado ningún archivo' });
  }

  console.log('📤 Archivo recibido:', req.file);

  const audioDir = path.join(
    __dirname,
    '..',
    'uploads',
    'webhook_whatsapp',
    'enviados',
    'audios'
  );
  try {
    // Crear el directorio si no existe
    console.log('🔧 Creando directorio si no existe:', audioDir);
    await fs.mkdir(audioDir, { recursive: true });

    const filePath = path.join(audioDir, req.file.filename);
    console.log('📁 Guardando archivo en:', filePath);

    // Mover el archivo desde la ubicación temporal
    await fs.rename(req.file.path, filePath);
    console.log('✅ Archivo movido correctamente a:', filePath);

    // Generar la URL para acceder al archivo guardado
    const fileUrlOnServer = `https://chat.imporfactory.app/uploads/webhook_whatsapp/enviados/audios/${req.file.filename}`;
    console.log('🌐 URL del archivo guardado:', fileUrlOnServer);

    // Devolver la URL del archivo guardado en el servidor
    return res.status(200).json({
      message: 'Audio guardado correctamente',
      fileUrl: fileUrlOnServer,
    });
  } catch (err) {
    console.error('❌ Error al guardar el audio:', err);
    return res.status(500).json({
      error: 'Error al guardar el audio enviado',
      details: err.message,
    });
  }
});

module.exports = router;
