const express = require('express');
const axios = require('axios');
const multer = require('multer');
const FormData = require('form-data');

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 110 * 1024 * 1024 }, // margen
});

function safeName(name = 'file') {
  return String(name).replace(/[^\w.\-() ]+/g, '_');
}

async function uploadToUploader({
  buffer,
  originalname,
  mimetype,
  folder = 'media',
}) {
  const form = new FormData();

  const fileName = safeName(originalname || `file-${Date.now()}`);
  form.append('file', buffer, {
    filename: `${folder}/${Date.now()}-${fileName}`,
    contentType: mimetype || 'application/octet-stream',
  });

  const uploaderResp = await axios.post(
    'https://uploader.imporfactory.app/api/files/upload',
    form,
    { headers: form.getHeaders(), timeout: 30000, validateStatus: () => true },
  );

  if (uploaderResp.status < 200 || uploaderResp.status >= 300) {
    return {
      ok: false,
      status: uploaderResp.status,
      data: uploaderResp.data,
    };
  }

  const json = uploaderResp.data;
  if (!json?.success || !json?.data?.url) {
    return {
      ok: false,
      status: 502,
      data: json,
    };
  }

  return { ok: true, url: json.data.url, data: json.data };
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
