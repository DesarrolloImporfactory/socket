const express = require('express');
const router = express.Router();

const { protect } = require('../middlewares/auth.middleware');
const checkPlanActivo = require('../middlewares/checkPlanActivo.middleware');
const requireSuperAdmin = require('../middlewares/requireSuperAdmin.middleware');
const ctrl = require('../controllers/telefonia.controller');

/* Telefonía por saldo (Zadarma). El webhook va sin sesión y con cuerpo
   form-urlencoded (Zadarma no manda JSON); todo lo demás con sesión. */
router
  .route('/webhook')
  .get(ctrl.webhook)
  .post(express.urlencoded({ extended: false }), ctrl.webhook);

router.use(protect, checkPlanActivo);

// ── Asesor ──
router.get('/widget', ctrl.widget); // llave + login SIP del widget WebRTC
router.get('/saldo', ctrl.saldo); // saldo y tarifa de la conexión
router.post('/llamar', ctrl.llamar); // callback: suena el widget, luego el cliente
router.get('/historial', ctrl.historial);
router.get('/movimientos', ctrl.movimientos);

// ── Super administrador (Imporfactory) ──
router.post('/recargar', requireSuperAdmin, ctrl.recargar);
router.post('/cuenta', requireSuperAdmin, ctrl.configurarCuenta); // caller_id, tarifa, activo (comprueba el número)
router.post('/cuenta/comprobar-numero', requireSuperAdmin, ctrl.comprobarNumero); // ¿verificado en Zadarma?
router.get('/diagnostico', requireSuperAdmin, ctrl.diagnostico);
router.post('/instalar', requireSuperAdmin, ctrl.instalar); // registra webhook + grabación
router.get('/maestra', requireSuperAdmin, ctrl.maestraEstado); // llaves guardadas + saldo Zadarma
router.post('/maestra', requireSuperAdmin, ctrl.maestraGuardar); // guarda llaves (prueba contra Zadarma)
router.get('/cuentas', requireSuperAdmin, ctrl.cuentas); // conexiones con saldo + cobertura
router.get('/admin/historial', requireSuperAdmin, ctrl.historialAdmin); // llamadas de una conexión, paginado
router.get('/ia', requireSuperAdmin, ctrl.iaEstado); // conteo de análisis con IA (la llave es la de cada conexión)
router.post('/ia/reanalizar', requireSuperAdmin, ctrl.iaReanalizar); // reintenta las que quedaron sin llave o con error
router.get('/costo', requireSuperAdmin, ctrl.costo); // costo real por minuto según país
router.get('/conexiones', requireSuperAdmin, ctrl.conexiones); // buscador para dar saldo

module.exports = router;
