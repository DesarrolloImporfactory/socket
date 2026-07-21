const express = require('express');
const multer = require('multer');
const router = express.Router();

const whatsappCtrl = require('../controllers/whatsapp.controller');

/* ────────────────────────────────────────────────
   Multer (memoria) + wrapper de errores limpio
   Se queda en routes porque es middleware de ruta.
   ──────────────────────────────────────────────── */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 110 * 1024 * 1024 }, // 110MB para margen (doc 100MB)
});

/**
 * Wrapper que convierte MulterError en un 400 JSON limpio
 * en vez de burbujear como 500 por el error handler global.
 */
const uploadSingle = (fieldName) => (req, res, next) => {
  upload.single(fieldName)(req, res, (err) => {
    if (!err) return next();
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({
        success: false,
        message: `El archivo supera el límite permitido (110 MB).`,
        code: 'LIMIT_FILE_SIZE',
      });
    }
    return res.status(400).json({
      success: false,
      message: err.message || 'Error al procesar el archivo.',
    });
  });
};

/* ════════════════════════════════════════════════
   NÚMEROS / CONEXIÓN
   ════════════════════════════════════════════════ */
router.post('/ObtenerNumeros', whatsappCtrl.obtener_numeros);
router.post('/estadoConexion', whatsappCtrl.estadoConexion);
router.get('/numero_status', whatsappCtrl.numero_status);
router.post(
  '/limpiar_credenciales_whatsapp',
  whatsappCtrl.limpiar_credenciales_whatsapp,
);

/* ════════════════════════════════════════════════
   PLANTILLAS META (message_templates)
   ════════════════════════════════════════════════ */
router.post(
  '/CrearPlantilla',
  uploadSingle('headerFile'),
  whatsappCtrl.crearPlantilla,
);
router.post('/obtenerTemplatesWhatsapp', whatsappCtrl.obtenerTemplatesWhatsapp);
router.post(
  '/crearPlantillasAutomaticas',
  whatsappCtrl.crearPlantillasAutomaticas,
);
router.post('/eliminarTemplateMeta', whatsappCtrl.eliminarTemplateMeta);

/* ════════════════════════════════════════════════
   PLANTILLAS RÁPIDAS (templates_chat_center)
   ════════════════════════════════════════════════ */
router.post('/obtenerRespuestasRapidas', whatsappCtrl.obtenerRespuestasRapidas);
router.post('/crearPlantillaRapida', whatsappCtrl.crearPlantillaRapida);
router.put('/cambiarEstado', whatsappCtrl.cambiarEstado);
router.delete('/eliminarPlantilla', whatsappCtrl.eliminarPlantilla);
router.put('/EditarPlantilla', whatsappCtrl.editarPlantilla);
router.post(
  '/uploadVideoPlantillaRapida',
  uploadSingle('file'),
  whatsappCtrl.uploadVideoPlantillaRapida,
);

/* ════════════════════════════════════════════════
   CONFIGURACIÓN
   ════════════════════════════════════════════════ */
router.put('/editarConfiguracion', whatsappCtrl.editarConfiguracion);
router.put(
  '/editarConfiguracionCalendario',
  whatsappCtrl.editarConfiguracionCalendario,
);
router.put('/actualizarMetodoPago', whatsappCtrl.actualizarMetodoPago);
router.post('/obtenerConfiguracion', whatsappCtrl.obtenerConfiguracion);
router.post(
  '/configuracionesAutomatizador',
  whatsappCtrl.configuracionesAutomatizador,
);
router.post(
  '/actualizarConfiguracionMeta',
  whatsappCtrl.actualizarConfiguracionMeta,
);

/* ════════════════════════════════════════════════
   ONBOARDING / COEXISTENCIA
   ════════════════════════════════════════════════ */
router.post('/embeddedSignupComplete', whatsappCtrl.embeddedSignupComplete);
router.post('/coexistencia/sync', whatsappCtrl.coexistenciaSync);

/* ════════════════════════════════════════════════
   AUDIO
   ════════════════════════════════════════════════ */
router.post('/enviarAudio', uploadSingle('audio'), whatsappCtrl.enviarAudio);
router.post(
  '/enviarAudioCompleto',
  uploadSingle('audio'),
  whatsappCtrl.enviarAudioCompleto,
);

/* ════════════════════════════════════════════════
   ENVÍO MASIVO / PROGRAMADOS
   ════════════════════════════════════════════════ */
// Convierte + sube el header UNA vez y devuelve el media_id que el front
// reparte a todo el lote (evita N conversiones idénticas en un masivo).
router.post(
  '/preparar_header_masivo',
  uploadSingle('header_file'),
  whatsappCtrl.prepararHeaderMasivo,
);
router.post(
  '/enviar_template_masivo',
  uploadSingle('header_file'),
  whatsappCtrl.enviarTemplateMasivo,
);
router.post(
  '/programar_template_masivo',
  uploadSingle('header_file'),
  whatsappCtrl.programarTemplateMasivo,
);
router.post(
  '/enviar-video-file',
  uploadSingle('file'),
  whatsappCtrl.enviarVideoWhatsappFile,
);

router.get('/programados_por_chat', whatsappCtrl.listarProgramadosPorChat);
router.get('/programados_por_config', whatsappCtrl.programados_por_config);
router.get('/templates_programados', whatsappCtrl.templates_programados);

router.put('/programados_editar_fecha', whatsappCtrl.editarFechaLote);
router.delete('/programados_cancelar_lote', whatsappCtrl.cancelarLote);
router.post('/programados_reintentar_lote', whatsappCtrl.reintentarLote);

module.exports = router;
