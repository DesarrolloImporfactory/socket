const express = require('express');
const router = express.Router();

const { protect } = require('../middlewares/auth.middleware');
const checkPlanActivo = require('../middlewares/checkPlanActivo.middleware');
const excluirRoles = require('../middlewares/excluirRoles.middleware');
const ctrl = require('../controllers/llamadas_whatsapp.controller');

/* Llamadas de voz por WhatsApp. El webhook `calls` NO entra por aquí: llega
   por /webhook_meta/webhook_whatsapp y el controlador de ese webhook lo
   deriva al servicio. Acá van las acciones del asesor y la configuración. */
router.use(protect, checkPlanActivo);

// ── Acciones del asesor sobre una llamada ──
router.post('/aceptar', ctrl.aceptar); // reclama + pre_accept (manda la SDP)
router.post('/confirmar', ctrl.confirmar); // audio conectado → accept
router.post('/rechazar', ctrl.rechazar);
router.post('/terminar', ctrl.terminar);
router.get('/activas', ctrl.activas);

// ── Fase 2: el negocio llama al cliente ──
router.get('/permiso', ctrl.estadoPermiso); // ¿puedo pedir permiso / llamar?
router.post('/permiso/solicitar', ctrl.solicitarPermiso); // mensaje "¿podemos llamarte?"
router.post('/llamar', ctrl.llamar); // connect (manda la oferta SDP)

// ── Historial (chat y dashboard) ──
router.get('/historial', ctrl.historial);

// ── Función de llamadas en el número: leerla cualquiera (el botón del chat
//    la necesita), cambiarla solo admins ──
router.get('/configuracion', ctrl.obtenerConfiguracion);
router.post('/configuracion', excluirRoles('ventas'), ctrl.guardarConfiguracion);

module.exports = router;
