const departamentos_chat_center = require('../controllers/departamentos_chat_center.controller');

const express = require('express');

const router = express.Router();

const { protect } = require('../middlewares/auth.middleware');

const {
  requireChatPropietario,
} = require('../middlewares/chatPropietario.middleware');
const checkPlanActivo = require('../middlewares/checkPlanActivo.middleware');
const restrictToRoles = require('../middlewares/restrictTo.middleware');
const excluirRoles = require('../middlewares/excluirRoles.middleware');

router.use(protect);

router.post(
  '/listarDepartamentos',
  checkPlanActivo,
  departamentos_chat_center.listarDepartamentos,
);

router.post(
  '/toggle_permiso_round_robin',
  checkPlanActivo,
  excluirRoles('ventas'),
  departamentos_chat_center.togglePermisoRoundRobin,
);

router.post(
  '/listar_por_usuario',
  checkPlanActivo,
  departamentos_chat_center.listar_por_usuario,
);

/* Crear, editar y borrar departamentos es del administrador de la cuenta,
   igual que los subusuarios y las conexiones (mismo guard que en
   usuarios_chat_center.routes.js). Transferir chats y asignar encargado
   siguen abiertos a todos los roles: son parte de atender. */
router.post(
  '/agregarDepartamento',
  restrictToRoles('administrador'),
  departamentos_chat_center.agregarDepartamento,
);

router.post(
  '/actualizarDepartamento',
  restrictToRoles('administrador'),
  departamentos_chat_center.actualizarDepartamento,
);

router.delete(
  '/eliminarDepartamento',
  restrictToRoles('administrador'),
  departamentos_chat_center.eliminarDepartamento,
);

router.post('/transferirChat', departamentos_chat_center.transferirChat);

router.post(
  '/asignar_encargado',
  requireChatPropietario('id_cliente_chat_center'),
  departamentos_chat_center.asignar_encargado,
);

router.get(
  '/historial-encargados/:id_cliente_chat_center',
  departamentos_chat_center.obtenerHistorialEncargados,
);

router.get(
  '/sub-usuarios-por-configuracion/:id_configuracion',
  checkPlanActivo,
  departamentos_chat_center.subUsuariosPorConfiguracion,
);

router.get(
  '/reparto/:id_departamento',
  checkPlanActivo,
  departamentos_chat_center.repartoDepartamento,
);

module.exports = router;
