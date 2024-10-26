const express = require('express');

const { webhook } = require('../controllers/chat.controller');

const router = express.Router();

router.get('/', async (req, res) => {
  try {
    return res.status(200).json({ message: 'Webhook working!' });
  } catch (error) {}
});

router.post('/webhook', webhook);

module.exports = router;
