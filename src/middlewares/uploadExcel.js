const multer = require('multer');

// Usamos memoria (no se guarda en disco)
const uploadExcel = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB máximo (ajustable)
  fileFilter: (req, file, cb) => {
    if (
      file.mimetype === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' || // .xlsx
      file.mimetype === 'application/vnd.ms-excel' // .xls
    ) {
      cb(null, true);
    } else {
      cb(new Error('Formato no válido. Solo se permiten archivos Excel.'));
    }
  }
}).single('archivoExcel'); // campo en el FormData

module.exports = { uploadExcel };
