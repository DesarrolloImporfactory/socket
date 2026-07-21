const express = require('express');
const ctrl = require('../controllers/imporchat_cartera.controller');
const auth = require('../middlewares/auth.middleware');

const router = express.Router();

/* Solo sesión de asesor. El filtro por conexión de soporte lo hace el
   controlador (exigirSoporte), porque el id_configuracion que llega es el de
   la cuenta CONSULTADA, no el del asesor. */
router.use(auth.protect);

router.get('/buscar', ctrl.buscar);
router.get('/resumen', ctrl.resumen);

module.exports = router;
