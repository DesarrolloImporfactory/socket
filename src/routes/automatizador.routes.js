const automatizadorController = require('../controllers/automatizador.controller');

const express = require('express');

const router = express.Router();


router.post(
  '/obtenerCategoriasAutomatizador',
  automatizadorController.obtenerCategoriasAutomatizador
);

router.post(
  '/obtenerTemplatesAutomatizador',
  automatizadorController.obtenerTemplatesAutomatizador
);

router.post(
  '/obtenerEtiquetasAutomatizador',
  automatizadorController.obtenerEtiquetasAutomatizador
);
module.exports = router;
