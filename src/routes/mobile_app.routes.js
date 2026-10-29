const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const multer = require('multer');

const authMiddleware = require('../middlewares/auth.middleware');
const restrictToRoles = require('../middlewares/restrictTo.middleware');
const controller = require('../controllers/mobile_app.controller');

const router = express.Router();
const uploadDirectory = path.resolve(
  process.env.MOBILE_ANDROID_RELEASE_DIR ||
    path.join(__dirname, '../uploads/mobile/android'),
);
fs.mkdirSync(uploadDirectory, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: uploadDirectory,
    filename: (_req, _file, callback) =>
      callback(null, `.incoming-${crypto.randomUUID()}.apk`),
  }),
  limits: { fileSize: 120 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, callback) => {
    if (!String(file.originalname || '').toLowerCase().endsWith('.apk')) {
      return callback(new Error('El archivo debe tener extensión .apk.'));
    }
    return callback(null, true);
  },
});

function receiveApk(req, res, next) {
  upload.single('apk')(req, res, (error) => {
    if (!error) return next();
    if (error.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({
        status: 'fail',
        message: 'El APK supera el límite de 120 MB.',
      });
    }
    return res.status(400).json({
      status: 'fail',
      message: error.message || 'No se pudo recibir el APK.',
    });
  });
}

router.get('/android/latest', controller.latest);
router.get('/android/download/:versionCode', controller.download);
router.post(
  '/android/publish',
  authMiddleware.protect,
  restrictToRoles('super_administrador'),
  receiveApk,
  controller.publish,
);

module.exports = router;
