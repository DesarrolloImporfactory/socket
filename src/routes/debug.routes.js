// routes/debug.routes.js
const express = require('express');
const { dbTime } = require('../controllers/debug.controller');
const router = express.Router();

router.get('/time', dbTime);
module.exports = router;
