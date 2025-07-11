const express = require('express');
const router = express.Router();
const SSO = require('../controllers/sso.controller');

// ⚠️  ¡Sin authMiddleware.protect!
router.get('/', SSO.sso);

module.exports = router;
