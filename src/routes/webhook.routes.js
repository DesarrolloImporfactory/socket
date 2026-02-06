const express = require('express');
const { upload } = require('../utils/multer');
const multer = require('multer');
const uploadMemory = multer({ storage: multer.memoryStorage() });
const { PassThrough } = require('stream');
const FormData = require('form-data');

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

router.post('/upload', uploadMemory.single('audio'), async (req, res) => {
  try {
    if (!req.file) {
      return res
        .status(400)
        .json({ error: 'No se ha proporcionado ningún archivo' });
    }

    const inputStream = new PassThrough();
    inputStream.end(req.file.buffer);

    const outputStream = new PassThrough();
    const chunks = [];

    outputStream.on('data', (chunk) => chunks.push(chunk));
    outputStream.on('end', () => {
      const outBuffer = Buffer.concat(chunks);
      return res.status(200).json({
        message: 'Archivo convertido y listo para enviar',
        file: outBuffer.toString('base64'),
        mimeType: 'audio/ogg',
      });
    });

    outputStream.on('error', (err) => {
      console.error('Error outputStream:', err);
      return res
        .status(500)
        .json({ error: 'Error generando el audio convertido' });
    });

    //Convierte el archivo
    ffmpeg(inputStream)
      .audioBitrate(128)
      .audioCodec('libopus')
      .format('ogg')
      .on('error', (err) => {
        console.error('Error en la conversión:', err);
        return res
          .status(500)
          .json({ error: 'Error en la conversión del archivo' });
      })
      .pipe(outputStream, { end: true });
  } catch (error) {
    console.error('Error /upload:', error);
    return res.status(500).json({ message: error.message });
  }
});

router.post(
  '/guardar_audio',
  uploadMemory.single('audio'),
  async (req, res) => {
    try {
      if (!req.file) {
        return res
          .status(400)
          .json({ error: 'No se ha proporcionado ningún archivo' });
      }

      // Subir al uploader (S3) desde el backend (sin escribir en disco)
      const form = new FormData();
      form.append('file', req.file.buffer, {
        filename: req.file.originalname || `audio-${Date.now()}.ogg`,
        contentType: req.file.mimetype || 'audio/ogg',
      });

      const uploaderResp = await axios.post(
        'https://uploader.imporfactory.app/api/files/upload',
        form,
        { headers: form.getHeaders() },
      );

      const json = uploaderResp.data;

      if (!json?.success) {
        return res.status(500).json({
          error: json?.message || 'Error subiendo archivo a uploader',
        });
      }

      const fileUrl = json.data?.url || '';

      return res.status(200).json({
        message: 'Audio subido correctamente',
        fileUrl,
        data: json.data,
      });
    } catch (err) {
      console.error('❌ Error /guardar_audio:', err?.response?.data || err);
      return res.status(500).json({
        error: 'Error al subir el audio enviado',
        details: err?.message,
      });
    }
  },
);

module.exports = router;
