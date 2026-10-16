const express = require('express');
const ctrl = require('../controllers/imporsuit_puente.controller');
const auth = require('../middlewares/auth.middleware');

const router = express.Router();

/* Sesión de asesor + cuenta de Imporfactory. La lista de controladores y
   métodos permitidos la valida el controlador. */
router.use(auth.protect, ctrl.exigirImporfactory);

router
  .route('/:controlador/:metodo/:parametro?')
  .get(ctrl.reenviar)
  .post(ctrl.reenviar);

module.exports = router;
