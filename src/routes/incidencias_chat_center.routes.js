const express = require('express');

const router = express.Router();

const { protect } = require('../middlewares/auth.middleware');
const incidencias = require('../controllers/incidencias_chat_center.controller');

router.use(protect);

router.get('/', incidencias.listar);
router.post('/', incidencias.crear);
router.delete('/:id', incidencias.eliminar);

module.exports = router;
