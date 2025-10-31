const automatizadorController = require('../controllers/automatizador.controller');

const express = require('express');

const router = express.Router();

// Cambiar a GET para facilitar las pruebas con query params
router.get(
  '/obtenerProductosAutomatizador',
  automatizadorController.obtenerProductosAutomatizador
);

router.get(
  '/obtenerCategoriasAutomatizador',
  automatizadorController.obtenerCategoriasAutomatizador
);

router.get(
  '/obtenerTemplatesAutomatizador',
  automatizadorController.obtenerTemplatesAutomatizador
);

router.get(
  '/obtenerEtiquetasAutomatizador',
  automatizadorController.obtenerEtiquetasAutomatizador
);

// También mantener las rutas POST por compatibilidad (usando body)
router.post(
  '/obtenerProductosAutomatizador',
  automatizadorController.obtenerProductosAutomatizador
);

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
