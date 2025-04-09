const plataformasController = require('../controllers/plataformas.controller');


const express = require('express');

const router = express.Router();

const { protect } = require('../middlewares/auth.middleware');

router.get('/', plataformasController.getAllPlataformas);

router.get('/:id_plataforma', plataformasController.getPlataformaById);
/*
router.use(protect);
*/


module.exports = router;