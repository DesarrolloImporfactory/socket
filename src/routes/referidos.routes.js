const express = require('express');
const multer = require('multer');
const referidosController = require('../controllers/referidos.controller');
const { protect } = require('../middlewares/auth.middleware');
const requireSuperAdmin = require('../middlewares/requireSuperAdmin.middleware');

const router = express.Router();

// En memoria: el comprobante se reenvía al uploader y nunca toca el disco de
// este servidor. 10 MB alcanza de sobra para una captura o un PDF del banco.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
});

// Pública: la consulta la pantalla de registro, que por definición no tiene
// sesión. Va ANTES del router.use(protect) o quedaría detrás del muro.
router.get('/validar/:codigo', referidosController.validarCodigo);

router.use(protect);

// Sin checkPlanActivo a propósito: alguien con el plan vencido tiene que poder
// entrar a ver —y a cobrar— lo que ya ganó. Bloquearle el saldo por no estar al
// día sería quedarse con dinero suyo.
router.get('/mi-programa', referidosController.miPrograma);
router.post('/aplicar-credito', referidosController.aplicarCredito);
router.post(
  '/solicitar-transferencia',
  referidosController.solicitarTransferencia,
);
router.post('/preferencia', referidosController.guardarPreferencia);

// ═══════════════════════════════════════════════════════
// Administración
// ═══════════════════════════════════════════════════════
router.get(
  '/admin/solicitudes',
  requireSuperAdmin,
  referidosController.listarSolicitudes,
);
router.get(
  '/admin/solicitudes/:id',
  requireSuperAdmin,
  referidosController.detalleSolicitud,
);
router.post(
  '/admin/solicitudes/:id',
  requireSuperAdmin,
  upload.single('comprobante'),
  referidosController.resolverSolicitud,
);

module.exports = router;
