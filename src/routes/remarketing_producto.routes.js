// routes/remarketing_producto.routes.js
// Remarketing por producto (menú Productos → Remarketing).
// Montado en /api/v1/remarketing-producto. Está en el skipPrefixes del
// sanitizador de app.js porque los mensajes llevan "$" en los precios.
const express = require('express');
const multer = require('multer');

const controller = require('../controllers/remarketing_producto.controller');
const { protect } = require('../middlewares/auth.middleware');
const checkPlanActivo = require('../middlewares/checkPlanActivo.middleware');

const router = express.Router();

/* Capturas de opiniones, fotos, video o PDF de los bloques. En memoria: el
   servicio lo sube al uploader (dedupe por hash). 16 MB = tope de WhatsApp
   para video. */
const MIMES = new Set([
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/webp',
  'video/mp4',
  'video/3gpp',
  'application/pdf',
]);
const subirArchivo = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 16 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (MIMES.has(file.mimetype)) return cb(null, true);
    cb(new Error('Formato no permitido: usa JPG, PNG, WEBP, MP4 o PDF.'));
  },
}).single('archivo');

const subirArchivoHandler = (req, res, next) => {
  subirArchivo(req, res, (err) => {
    if (err) {
      const message =
        err.code === 'LIMIT_FILE_SIZE'
          ? 'El archivo supera los 16 MB.'
          : err.message;
      return res.status(400).json({ status: 'fail', message });
    }
    next();
  });
};

router.use(protect);

router.post('/listar', checkPlanActivo, controller.listar);
router.post('/obtener', checkPlanActivo, controller.obtener);
router.post('/guardar', checkPlanActivo, controller.guardar);
router.post('/activar', checkPlanActivo, controller.activar);
router.post('/eliminar', checkPlanActivo, controller.eliminar);
router.post(
  '/subir-media',
  checkPlanActivo,
  subirArchivoHandler,
  controller.subirMedia,
);
router.post('/probar', checkPlanActivo, controller.probar);

module.exports = router;
