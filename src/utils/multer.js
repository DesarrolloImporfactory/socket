const multer = require('multer');
const path = require('path');

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    // Especifica la carpeta de destino
    cb(null, path.join(__dirname, '../uploads/audios'));
  },
  filename: (req, file, cb) => {
    // Genera un nombre único para el archivo
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, uniqueSuffix + '-' + file.originalname);
  },
});

const upload = multer({
  storage,
  fileFilter: (req, file, cb) => {
    const allowedFileTypes = [
      'image/jpeg',
      'image/png',
      'audio/mpeg',
      'audio/wav',
      'audio/ogg',
    ];

    if (allowedFileTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Tipo de archivo no permitido'));
    }
  },
});

module.exports = { upload };
