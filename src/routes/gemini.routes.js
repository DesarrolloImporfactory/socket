const express = require('express');
const router = express.Router();

const { protect } = require('../middlewares/auth.middleware');
const checkPlanActivo = require('../middlewares/checkPlanActivo.middleware');

const geminiController = require('../controllers/gemini.controller');

const multer = require('multer');

// ✅ memory storage: no guarda nada en disco
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 8 * 1024 * 1024, // 8MB por imagen (ajusta)
    files: 6, // máximo 6 imágenes
  },
});

router.use(protect);

router.post(
  '/obtener_api_key',
  checkPlanActivo,
  geminiController.obtener_api_key,
);
router.post(
  '/guardar_api_key',
  checkPlanActivo,
  geminiController.guardar_api_key,
);

router.post(
  '/generar',
  checkPlanActivo,
  upload.array('user_images', 6),
  geminiController.generar_multipart,
);

module.exports = router;
