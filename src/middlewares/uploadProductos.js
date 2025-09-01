// middlewares/uploadProductos.js
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

// Directorios
const UPLOAD_BASE = path.join(__dirname, '..', 'uploads', 'productos');
const DIR_IMG = path.join(UPLOAD_BASE, 'imagen');
const DIR_VIDEO = path.join(UPLOAD_BASE, 'video');

// Crear carpetas si no existen
[UPLOAD_BASE, DIR_IMG, DIR_VIDEO].forEach((dir) => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    if (file.fieldname === 'imagen') return cb(null, DIR_IMG);
    if (file.fieldname === 'video')  return cb(null, DIR_VIDEO);
    return cb(null, UPLOAD_BASE); // fallback (no debería usarse)
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `${uuidv4()}${ext}`);
  },
});

const allowed = {
  imagen: ['image/jpeg', 'image/png', 'image/webp', 'image/jpg', 'image/gif'],
  video:  ['video/mp4', 'video/webm', 'video/ogg', 'video/quicktime', 'video/x-msvideo'],
};

const fileFilter = (req, file, cb) => {
  const lista = allowed[file.fieldname] || [];
  if (lista.includes(file.mimetype)) return cb(null, true);
  cb(new Error(`Tipo de archivo no permitido para "${file.fieldname}".`));
};

const uploadProductoMedia = multer({
  storage,
  fileFilter,
  limits: { fileSize: 60 * 1024 * 1024 }, // 60MB global
}).fields([
  { name: 'imagen', maxCount: 1 },
  { name: 'video',  maxCount: 1 },
]);

module.exports = { uploadProductoMedia };
