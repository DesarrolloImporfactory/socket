const express = require('express');
const multer = require('multer');
const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { protect } = require('../middlewares/auth.middleware');
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

async function saveLocally({ req, kind, uploaderError }) {
  const category =
    kind === 'image'
      ? 'images'
      : kind === 'video'
        ? 'videos'
        : kind === 'audio'
          ? 'audios'
          : 'files';
  const extension = path.extname(req.file.originalname || '').toLowerCase();
  const safeExtension = /^\.[a-z0-9]{1,10}$/.test(extension) ? extension : '';
  const filename = `${Date.now()}-${crypto.randomBytes(12).toString('hex')}${safeExtension}`;
  const directory = path.resolve(__dirname, '../uploads/chat-media', category);
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, filename), req.file.buffer, { flag: 'wx' });

  const publicBase = String(
    process.env.CHAT_API_PUBLIC_BASE_URL || 'https://chatapi.imporchat.com',
  ).replace(/\/+$/, '');
  return {
    success: true,
    url: `${publicBase}/uploads/chat-media/${category}/${filename}`,
    file: {
      name: req.file.originalname,
      mime_type: req.file.mimetype,
      size: req.file.size,
      kind: kind || null,
    },
    storage: 'local',
    uploader_error: uploaderError,
  };
}

/**
 * POST /api/v1/media/upload
 * multipart/form-data
 * fields:
 * - file (required)
 * - kind (optional): image|video|file
 * - folder (optional): media path en uploader
 */
router.post('/upload', protect, upload.single('file'), async (req, res) => {
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
      try {
        const saved = await saveLocally({
          req,
          kind,
          uploaderError: {
            status: up.status,
            message: up.data?.message || up.data?.error || 'Uploader rechazó el archivo.',
          },
        });
        console.warn('[media] Uploader no disponible; archivo guardado localmente', {
          userId: req.user?.id,
          status: up.status,
          kind: kind || 'file',
          size: req.file.size,
        });
        return res.json(saved);
      } catch (storageError) {
        console.error('[media] Fallaron uploader y almacenamiento local', {
          status: up.status,
          error: storageError?.message,
        });
        return res.status(503).json({
          success: false,
          message: 'No se pudo guardar el archivo. Inténtalo de nuevo.',
          uploader_status: up.status,
          storage_error: storageError?.message || 'unknown',
        });
      }
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
