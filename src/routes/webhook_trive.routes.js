const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/webhook_trive.controller');

// SIN protect — es webhook externo, se valida con x-webhook-secret
router.post('/inbound_trive', ctrl.inbound_trive);
router.get('/inbound_trive', ctrl.inbound_trive);

module.exports = router;
