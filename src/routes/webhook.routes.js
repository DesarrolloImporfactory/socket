const express = require('express');
const { upload } = require('../utils/multer');
const { webhook } = require('../controllers/chat.controller');
const ffmpeg = require('fluent-ffmpeg');
const router = express.Router();
const path = require('path');
const fs = require('fs');

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
      .on('end', () => {
        fs.unlinkSync(inputFilePath); // Elimina el archivo original después de la conversión si es necesario

        // Lee el archivo convertido y envíalo al cliente
        fs.readFile(outputFilePath, (err, data) => {
          if (err) {
            console.error('Error al leer el archivo convertido:', err);
            return res
              .status(500)
              .json({ error: 'Error al leer el archivo convertido' });
          }

          // Borra el archivo convertido después de leerlo si es necesario
          fs.unlinkSync(outputFilePath);

          // Devuelve el archivo como respuesta en formato binario
          res.status(200).json({
            message: 'Archivo convertido y listo para enviar',
            file: data.toString('base64'), // Lo convierte a Base64 para enviar en JSON
          });
        });
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

module.exports = router;
