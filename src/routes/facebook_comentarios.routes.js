const express = require('express');
const ctrl = require('../controllers/facebook_comentarios.controller');
const { protect, protectConfigOwner } = require('../middlewares/auth.middleware');

const router = express.Router();

// Bandeja de comentarios de publicaciones de Facebook.
//
// Todas son de lectura y todas van con `protectConfigOwner`: los comentarios
// son datos de los clientes finales del negocio, así que un id_configuracion
// que no sea del usuario autenticado tiene que cortar en 403 antes de tocar la
// base. `protect` va primero porque protectConfigOwner necesita req.sessionUser.
router.use(protect, protectConfigOwner);

router.get('/posts', ctrl.listarPosts);
router.get('/posts/:id_facebook_post/comentarios', ctrl.listarComentarios);
router.get('/resumen', ctrl.resumen);

// Escritura: publican en Facebook con el token de la página.
router.post('/responder', ctrl.responder);
router.post('/responder-privado', ctrl.responderEnPrivado);

module.exports = router;
