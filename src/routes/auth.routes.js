const authController = require('../controllers/auth.controller');
const usersMiddleware = require('../middlewares/users.middleware');
const validationMiddleware = require('./../middlewares/validations.middleware');
const express = require('express');
const router = express.Router();

const authMiddleware = require('../middlewares/auth.middleware');

const { upload } = require('../utils/multer');
// route for post request to create a new user
router.post(
  '/signup',
  validationMiddleware.createUserValidation,
  authController.signup
);

// route for post request to login a user
router.post('/login', authController.login);

router.use(authMiddleware.protect);

router.get('/renew', authController.renew);

module.exports = router;