const authController = require('../controllers/auth.controller');
const passwordResetController = require('../controllers/password_reset.controller');
const validationMiddleware = require('./../middlewares/validations.middleware');
const express = require('express');
const router = express.Router();

const authMiddleware = require('../middlewares/auth.middleware');

// route for post request to create a new user
router.post(
  '/registro',
  validationMiddleware.createUserValidation,
  authController.registrarUsuario,
);

// route for post request to login a user
router.post('/login', authController.login);
router.post('/newLogin', authController.newLogin);

router.post(
  '/validar_usuario_imporsuit',
  authController.validar_usuario_imporsuit,
);

// Recuperación de contraseña (3 pasos, todas públicas)
router.post('/password-reset/request', passwordResetController.requestCode);
router.post('/password-reset/verify', passwordResetController.verifyCode);
router.post('/password-reset/change', passwordResetController.changePassword);

router.use(authMiddleware.protect);

router.get('/renew', authController.renew);

module.exports = router;
