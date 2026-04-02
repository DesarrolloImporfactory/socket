const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/webhoook_contactos.controller');

// SIN protect — es webhook externo, se valida con x-webhook-secret
router.post('/inbound', ctrl.inbound);

module.exports = router;
