// routes/agenda_publica.routes.js — agenda pública de citas (/agendar/:slug).
const express = require('express');
const rateLimit = require('express-rate-limit');
const { protect, protectConfigOwner } = require('../middlewares/auth.middleware');
const requireSuperAdmin = require('../middlewares/requireSuperAdmin.middleware');
const ctrl = require('../controllers/agenda_publica.controller');

const router = express.Router();

/* La reserva crea citas y contactos a partir de lo que teclea cualquiera. El
   limiter global de /api/v1 (100.000/h) no protege nada, y limitar por IP
   tampoco sirve: sin trust proxy todos comparten la misma req.ip. Se limita
   por teléfono/correo, que es lo que hay que cuidar: que un mismo número no
   llene la agenda a reservas. El servicio además devuelve la reunión ya
   hecha si la persona repite. */
const reservarLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 8,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    const tel = String(req.body?.telefono || '').replace(/\D/g, '');
    const email = String(req.body?.email || '').trim().toLowerCase();
    return tel ? `agenda:tel:${tel}` : email ? `agenda:mail:${email}` : `agenda:ip:${req.ip}`;
  },
  message: {
    status: 'fail',
    message: 'Ya registramos varias reservas con estos datos, intenta más tarde',
  },
});

// Públicos (sin sesión): los usa /agendar y /agendar/:slug
router.get('/disponibilidad', ctrl.disponibilidad);
router.post('/reservar', reservarLimiter, ctrl.reservar);

// Panel de cada cuenta (Calendario → Agenda pública). id_configuracion en
// query o body; protectConfigOwner verifica que sea de la sesión.
router.get('/mi/resumen', protect, protectConfigOwner, ctrl.resumen);
router.get('/mi/plantillas', protect, protectConfigOwner, ctrl.plantillas);
router.post('/mi/config', protect, protectConfigOwner, ctrl.guardarConfig);
router.post('/mi/asesores', protect, protectConfigOwner, ctrl.guardarAsesores);
router.post('/mi/google/usar', protect, protectConfigOwner, ctrl.googleUsar);
router.post('/mi/google/quitar', protect, protectConfigOwner, ctrl.googleQuitar);
router.post('/mi/google/importar', protect, protectConfigOwner, ctrl.googleImportar);

// Agenda principal (modal de arranque y /home): solo super admin
const principal = (req, _res, next) => {
  req.agendaPrincipal = true;
  next();
};
router.get('/admin/resumen', protect, requireSuperAdmin, principal, ctrl.resumen);
router.get('/admin/plantillas', protect, requireSuperAdmin, principal, ctrl.plantillas);
router.post('/admin/config', protect, requireSuperAdmin, principal, ctrl.guardarConfig);
router.post('/admin/asesores', protect, requireSuperAdmin, principal, ctrl.guardarAsesores);
router.post('/admin/google/usar', protect, requireSuperAdmin, principal, ctrl.googleUsar);
router.post('/admin/google/quitar', protect, requireSuperAdmin, principal, ctrl.googleQuitar);
router.post('/admin/google/importar', protect, requireSuperAdmin, principal, ctrl.googleImportar);

module.exports = router;
