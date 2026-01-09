const clientes_chat_centerController = require('../controllers/clientes_chat_center.controller');
const EtiquetasAsignadasController = require('../controllers/etiquetas_asignadas.controller');

const express = require('express');

const router = express.Router();

const { protect } = require('../middlewares/auth.middleware');

router.use(protect);

// routes/clientes_chat_center.routes.js
router.post(
  '/actualizar_cerrado',
  clientes_chat_centerController.actualizar_cerrado
);

router.post(
  '/actualizar_bot_openia',
  clientes_chat_centerController.actualizar_bot_openia
);

router.post(
  '/agregarNumeroChat',
  clientes_chat_centerController.agregarNumeroChat
);

router.post(
  '/buscar_id_recibe',
  clientes_chat_centerController.buscar_id_recibe
);

router.post(
  '/agregarMensajeEnviado',
  clientes_chat_centerController.agregarMensajeEnviado
);

router.post(
  '/actualizarMensajeReenviado',
  clientes_chat_centerController.actualizarMensajeReenviado
);

router.get(
  '/findFullByPhone_desconect/:phone',
  clientes_chat_centerController.findFullByPhone_desconect
);

router.get(
  '/findFullByPhone/:phone',
  clientes_chat_centerController.findFullByPhone
);

router.post(
  '/listar_contactos_estado',
  clientes_chat_centerController.listarContactosEstado
);

router.post(
  '/actualizar_estado',
  clientes_chat_centerController.actualizarEstado
);
router.post(
  '/listar_ultimo_mensaje',
  clientes_chat_centerController.ultimo_mensaje
);

// CRUD limpio (SQL crudo)
router.get('/listar', clientes_chat_centerController.listarClientes);

router.post(
  '/etiquetas/multiples',
  EtiquetasAsignadasController.obtenerMultiples
);

// Nuevo: listar por etiqueta (many-to-many con etiquetas_asignadas)
router.get(
  '/listar_por_etiqueta',
  clientes_chat_centerController.listarClientesPorEtiqueta
);
router.post('/agregar', clientes_chat_centerController.agregarCliente);
router.put('/actualizar/:id', clientes_chat_centerController.actualizarCliente);
router.delete('/eliminar/:id', clientes_chat_centerController.eliminarCliente);
router.post('/eliminar', clientes_chat_centerController.eliminarClientesBulk); // bulk

router.get(
  '/total_clientes_ultimo_mes',
  clientes_chat_centerController.totalClientesUltimoMes
);

router.get(
  '/total_clientes_ultimo_mes_todos',
  clientes_chat_centerController.totalClientesUltimoMesTodos
);

module.exports = router;
