const express = require('express');
const router = express.Router();
const { protect } = require('../middlewares/auth.middleware');
const requireRecuperacion = require('../middlewares/requireRecuperacion.middleware');
const ctrl = require('../controllers/recuperacion.controller');

router.use(protect);

// Para pintar (o no) el ítem del menú: responde a cualquier usuario autenticado.
router.get('/acceso', ctrl.acceso);

router.use(requireRecuperacion);

router.get('/embudo', ctrl.embudo);
router.get('/resultados', ctrl.resultados);
router.get('/cliente/:id_usuario', ctrl.cliente);
// Antes de las rutas con :id_usuario: busca clientes con su último caso (abierto o cerrado).
router.get('/casos/buscar', ctrl.buscar);
router.post('/casos/:id_usuario/asignar', ctrl.asignar);
router.post('/casos/:id_usuario/cerrar', ctrl.cerrar);
router.post('/casos/:id_usuario/abrir', ctrl.abrir);
router.post('/casos/:id_usuario/abrir-chat-expertos', ctrl.abrirChatExpertos);

// Automatizaciones (ver y enviar a mano: cualquier asesor; configurar: admins)
router.get('/automatizaciones', ctrl.listarAutomatizaciones);
router.get('/automatizaciones/envios', ctrl.enviosAutomatizacion);
router.post('/automatizaciones/crear-plantillas', ctrl.crearPlantillasAutomatizacion);
router.get('/automatizaciones/:id/simular', ctrl.simularAutomatizacion);
router.post('/automatizaciones/:id/enviar-ahora', ctrl.enviarAhoraAutomatizacion);
router.patch('/automatizaciones/pasos/:id', ctrl.actualizarPasoAutomatizacion);
router.patch('/automatizaciones/:id', ctrl.actualizarAutomatizacion);

// Solo super admin (lo valida el controlador)
router.get('/asesores', ctrl.listarAsesores);
router.post('/asesores', ctrl.agregarAsesor);
router.patch('/asesores/:id_sub_usuario', ctrl.cambiarAsesor);
router.delete('/asesores/:id_sub_usuario', ctrl.quitarAsesor);

module.exports = router;
