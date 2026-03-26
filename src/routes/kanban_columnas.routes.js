// routes/kanban_columnas.routes.js
const express = require('express');
const router = express.Router();
const KanbanColumnasController = require('../controllers/kanban_columnas.controller');

const multer = require('multer');
const KanbanAsisteController = require('../controllers/kanban_asistente.controller');

// Todas las rutas usan POST para mantener consistencia con el resto de tu API

router.post('/listar', KanbanColumnasController.listarColumnas);
router.post('/obtener', KanbanColumnasController.obtenerColumna);
router.post('/crear', KanbanColumnasController.crearColumna);
router.post('/actualizar', KanbanColumnasController.actualizarColumna);
router.post('/eliminar', KanbanColumnasController.eliminarColumna);
router.post('/reordenar', KanbanColumnasController.reordenarColumnas);
router.post('/marcar_principal', KanbanColumnasController.marcarPrincipal);
router.post('/quitar_principal', KanbanColumnasController.quitarPrincipal);

router.post('/sync_catalogo', KanbanColumnasController.syncCatalogo);

router.post(
  '/sincronizar_catalogo',
  KanbanColumnasController.sincronizarCatalogo,
);
router.post('/sync_status', KanbanColumnasController.syncStatus);

/* SECCION DE CONTROLADORES ASISTENTES */
// Multer en memoria (sin guardar en disco — se envía directo a OpenAI)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 }, // 100 MB máximo
});

// Agregar a kanban_columnas.routes.js:
router.post('/obtener_asistente', KanbanAsisteController.obtenerAsistente);
router.post('/crear_asistente', KanbanAsisteController.crearAsistente);
router.post(
  '/actualizar_asistente',
  KanbanAsisteController.actualizarAsistente,
);
router.post(
  '/subir_archivo',
  upload.single('file'),
  KanbanAsisteController.subirArchivo,
);
router.post('/eliminar_archivo', KanbanAsisteController.eliminarArchivo);

module.exports = router;
