const express = require('express');
const router = express.Router();
const auth = require('../middlewares/auth.middleware');
const ctrl = require('../controllers/calendars.controller');

router.use(auth.protect);

router.get('/', ctrl.list);
router.post('/', ctrl.create);
router.post('/ensure', ctrl.ensure);
module.exports = router;
