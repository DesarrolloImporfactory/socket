const userController = require('../controllers/users.controller');
const express = require('express');

const router = express.Router();

const usersMiddleware = require('../middlewares/users.middleware');
const authMiddleware = require('../middlewares/auth.middleware');
router.use(authMiddleware.protect);
// routes
router.route('/').get(userController.findAllUsers);

router.get('/', userController.findAllUsers);

router.route('/:id').get(usersMiddleware.validUser, userController.findOneUser);

module.exports = router;
