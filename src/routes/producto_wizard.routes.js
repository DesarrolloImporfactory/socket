// routes/producto_wizard.routes.js
// Wizard de producto (vista /productos2). Montado en /api/v1/producto-wizard.
const express = require('express');
const multer = require('multer');

const controller = require('../controllers/producto_wizard.controller');
const { protect } = require('../middlewares/auth.middleware');
const checkPlanActivo = require('../middlewares/checkPlanActivo.middleware');

const router = express.Router();

/* Media del paquete (imagen o video). En memoria: el servicio la normaliza
   (JPG) y la sube al uploader; no queda nada en disco salvo que el uploader
   falle. 16 MB = tope de WhatsApp para video. */
const MIMES = new Set([
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/webp',
  'image/gif',
  'video/mp4',
  'video/webm',
  'video/quicktime',
  'video/3gpp',
  'video/mpeg',
]);
const subirArchivo = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 16 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (MIMES.has(file.mimetype)) return cb(null, true);
    cb(new Error('Formato no permitido: usa JPG, PNG, WEBP o MP4.'));
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
router.post('/eliminar', checkPlanActivo, controller.eliminar);
router.post('/preview-mensaje', checkPlanActivo, controller.preview);
router.post('/generar-textos', checkPlanActivo, controller.generarTextos);
router.post('/generar-imagen', checkPlanActivo, controller.generarImagen);
router.post(
  '/subir-media',
  checkPlanActivo,
  subirArchivoHandler,
  controller.subirMedia,
);
router.post('/foto-principal', checkPlanActivo, controller.fotoPrincipal);
router.post('/simular', checkPlanActivo, controller.simular);
router.post('/probar-respuesta', checkPlanActivo, controller.probarRespuesta);

module.exports = router;
