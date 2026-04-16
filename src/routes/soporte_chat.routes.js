const { Router } = require('express');
const router = Router();
const { checkDropi, ask } = require('../controllers/soporte_chat.controller');
const {
  protect,
  protectConfigOwner,
} = require('../middlewares/auth.middleware');

router.get('/check_dropi', protect, protectConfigOwner, checkDropi);
router.post('/ask', protect, ask);

module.exports = router;
