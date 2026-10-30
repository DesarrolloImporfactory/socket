const express = require('express');
const multer = require('multer');
const {
  uploadToUploader: subirAlUploader,
} = require('../utils/whatsappTemplate.helpers');

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 110 * 1024 * 1024 }, // margen
});

function safeName(name = 'file') {
  return String(name).replace(/[^\w.\-() ]+/g, '_');
}

// Misma subida que el resto del backend (con reutilización por hash), solo
// que aquí no lanza: devuelve { ok:false } como hacía la copia local.
async function uploadToUploader({
  buffer,
  originalname,
  mimetype,
  folder = 'media',
}) {
  try {
    const r = await subirAlUploader({
      buffer,
      originalname: safeName(originalname || `file-${Date.now()}`),
      mimetype,
      folder,
    });
    return { ok: true, url: r.fileUrl, data: r.data };
  } catch (err) {
    return {
      ok: false,
      status: err.statusCode || 502,
      data: err.raw || { message: err.message },
    };
  }
}

/**
 * POST /api/v1/media/upload
 * multipart/form-data
 * fields:
 * - file (required)
 * - kind (optional): image|video|file
 * - folder (optional): media path en uploader
 */
router.post('/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file?.buffer?.length) {
      return res
        .status(400)
        .json({ success: false, message: 'Archivo vacío o inválido.' });
    }

    const kind = String(req.body?.kind || '').toLowerCase();
    const folderRaw = String(req.body?.folder || '').trim();

    // folder por defecto según tipo
    const folder =
      folderRaw ||
      (kind === 'image'
        ? 'unified/attachments/images'
        : kind === 'video'
          ? 'unified/attachments/videos'
          : 'unified/attachments/files');

    const up = await uploadToUploader({
      buffer: req.file.buffer,
      originalname: req.file.originalname,
      mimetype: req.file.mimetype,
      folder,
    });

    if (!up.ok) {
      return res.status(200).json({
        success: false,
        message: 'No se pudo subir el archivo al uploader.',
        uploader_status: up.status,
        error: up.data,
      });
    }

    return res.json({
      success: true,
      url: up.url,
      file: {
        name: req.file.originalname,
        mime_type: req.file.mimetype,
        size: req.file.size,
        kind: kind || null,
      },
      data: up.data,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: 'Error interno subiendo archivo.',
      error: error?.message || 'unknown',
    });
  }
});

module.exports = router;
