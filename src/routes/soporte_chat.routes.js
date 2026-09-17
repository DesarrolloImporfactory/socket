const { Router } = require('express');
const router = Router();
const { checkDropi } = require('../controllers/soporte_chat.controller');
const {
  protect,
  protectConfigOwner,
} = require('../middlewares/auth.middleware');

router.get('/check_dropi', protect, protectConfigOwner, checkDropi);

module.exports = router;
