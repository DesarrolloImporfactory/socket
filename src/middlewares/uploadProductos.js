// middlewares/uploadProductos.js
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const UPLOAD_BASE = path.join(__dirname, '..', 'uploads', 'productos');
const DIR_IMG = path.join(UPLOAD_BASE, 'imagen');
const DIR_VIDEO = path.join(UPLOAD_BASE, 'video');
const DIR_UPSELL = path.join(UPLOAD_BASE, 'imagen_upsell');

[UPLOAD_BASE, DIR_IMG, DIR_VIDEO, DIR_UPSELL].forEach((dir) => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    if (file.fieldname === 'imagen') return cb(null, DIR_IMG);
    if (file.fieldname === 'video') return cb(null, DIR_VIDEO);
    if (file.fieldname === 'imagen_upsell') return cb(null, DIR_UPSELL);
    return cb(null, UPLOAD_BASE);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `${uuidv4()}${ext}`);
  },
});

const allowed = {
  imagen: ['image/jpeg', 'image/png', 'image/webp', 'image/jpg', 'image/gif'],
  video: [
    'video/mp4',
    'video/webm',
    'video/ogg',
    'video/quicktime',
    'video/x-msvideo',
    'video/mpeg',
    'video/3gpp',
  ],
  imagen_upsell: [
    'image/jpeg',
    'image/png',
    'image/webp',
    'image/jpg',
    'image/gif',
  ],
};

const fileFilter = (req, file, cb) => {
  const lista = allowed[file.fieldname] || [];
  if (lista.includes(file.mimetype)) return cb(null, true);
  cb(new Error(`Tipo de archivo no permitido para "${file.fieldname}".`));
};

const uploadProductoMedia = multer({
  storage,
  fileFilter,
  limits: { fileSize: 16 * 1024 * 1024 }, // ← 16 MB máx (límite WhatsApp)
}).fields([
  { name: 'imagen', maxCount: 1 },
  { name: 'video', maxCount: 1 },
  { name: 'imagen_upsell', maxCount: 1 },
]);

// Wrapper que convierte el error de multer en respuesta JSON legible
const uploadProductoMediaHandler = (req, res, next) => {
  uploadProductoMedia(req, res, (err) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({
          status: 'fail',
          message: 'El video supera el límite de 16 MB permitido por WhatsApp.',
        });
      }
      return res.status(400).json({ status: 'fail', message: err.message });
    }
    next();
  });
};

/* Imagen para generar la descripción con IA.
   Va a memoria y no a disco a propósito: la foto solo se usa para armar el
   data URL que se le manda a OpenAI y se descarta. Guardarla dejaría basura en
   uploads/ cada vez que alguien pulsa "generar" mientras todavía está armando
   el producto (que puede no llegar a guardarse nunca).
   El tope es 5 MB —no 16— porque base64 infla ~33% y el modelo tampoco necesita
   más resolución para describir un producto. */
const uploadImagenIA = multer({
  storage: multer.memoryStorage(),
  fileFilter: (req, file, cb) => {
    if (allowed.imagen.includes(file.mimetype)) return cb(null, true);
    cb(new Error('La imagen debe ser JPG, PNG, WEBP o GIF.'));
  },
  limits: { fileSize: 5 * 1024 * 1024 },
}).single('imagen');

const uploadImagenIAHandler = (req, res, next) => {
  uploadImagenIA(req, res, (err) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({
          status: 'fail',
          message: 'La imagen supera los 5 MB.',
        });
      }
      return res.status(400).json({ status: 'fail', message: err.message });
    }
    next();
  });
};

module.exports = {
  uploadProductoMedia: uploadProductoMediaHandler,
  uploadImagenIA: uploadImagenIAHandler,
};
