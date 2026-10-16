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
router.get('/comentarios', ctrl.listarComentariosPlano);
router.get('/resumen', ctrl.resumen);
router.get('/productos', ctrl.listarProductosVinculables);
router.get('/asistente', ctrl.obtenerAsistente);

// Vincular la publicación a un producto no toca Facebook: solo decide qué sabe
// el asistente cuando redacte una sugerencia en ese post.
router.post('/vincular-producto', ctrl.vincularProducto);

// Configurar el asistente y probarlo. Probar no guarda, no publica y ni
// siquiera necesita un comentario real: es para afinar el prompt a ciegas
// cero, viendo qué sale antes de que lo vea nadie.
router.put('/asistente', ctrl.guardarAsistente);
router.post('/probar-prompt', ctrl.probarPrompt);

// Sugerir tampoco publica: devuelve un borrador para que lo lea un agente.
router.post('/sugerir', ctrl.sugerir);

// Escritura de verdad: publican en Facebook con el token de la página.
router.post('/responder', ctrl.responder);
router.post('/responder-privado', ctrl.responderEnPrivado);

module.exports = router;
