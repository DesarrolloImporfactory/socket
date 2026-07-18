const express = require('express');
const router = express.Router();

const auth = require('../middlewares/auth.middleware');
const checkPlanActivo = require('../middlewares/checkPlanActivo.middleware');
const checkToolAccess = require('../middlewares/checkToolAccess.middleware');
const ctrl = require('../controllers/dropi_integrations.controller');
const dropiAutoOrderController = require('../controllers/dropi_auto_orders.controller');

const dropiboardGuard = [checkPlanActivo, checkToolAccess('dropiboard')];

router.use(auth.protect);

//CRUD Integrations
router.get('/', auth.protectConfigOwner, ctrl.list);
router.post('/', auth.protectConfigOwner, ctrl.create);
router.patch('/:id', ctrl.update);
router.delete('/:id', ctrl.remove);

// Vincular Dropi a nivel usuario (sin necesitar id_configuracion)
router.get('/my-integration', ctrl.getMyIntegration);
router.post('/my-integration', ctrl.createMyIntegration);
router.delete('/my-integration/:id', ctrl.removeMyIntegration);

//Crear orden
router.post(
  '/orders/myorders',
  auth.protectConfigOwner,
  ctrl.createOrderMyOrders,
);

//Crear orden automatica -> solo para repetir flujo desde front o debuguear
router.post(
  '/orders/myorders/auto-order',
  auth.resolverConfigDesdeLog, // ← resuelve id_configuracion desde id_log
  auth.protectConfigOwner, // ← valida ownership
  dropiAutoOrderController.probarAutoOrden,
);

router.post(
  '/auto-orders/pendientes',
  auth.protectConfigOwner,
  dropiAutoOrderController.listPendientesGenerarGuia,
);

// Datos del bot de un cliente (prellenar panel de crear orden)
router.post(
  '/auto-orders/datos-cliente',
  auth.protectConfigOwner,
  dropiAutoOrderController.datosBotCliente,
);

// Productos vinculados a Dropi (select del formulario de pedidos sin subir)
router.post(
  '/auto-orders/productos-vinculados',
  auth.protectConfigOwner,
  dropiAutoOrderController.listarProductosVinculados,
);

// Órdenes Shopify que entraron por webhook y no llegaron a Dropi (huérfanas)
router.post(
  '/auto-orders/shopify-huerfanas',
  auth.protectConfigOwner,
  dropiAutoOrderController.listShopifyHuerfanas,
);

//Consultar ordenes (post hacia dropi con filtros)
router.post(
  '/orders/myorders/list',
  auth.protectConfigOwner,
  ctrl.listMyOrders,
);

// Consultar ordenes desde el CACHE local (sin golpear la API de Dropi).
// Vista Pedidos: filtros + paginación real + enriquecimiento (chat, agente,
// imagen de producto del catálogo, estado del pedido, origen).
router.post(
  '/orders/cache/list',
  auth.protectConfigOwner,
  ctrl.listOrdersFromCache,
);

//Obtener Productos Dropi
router.post('/products/index', auth.protectConfigOwner, ctrl.listProductsIndex);

//Consultar States (con country_id)
router.get('/location/states', auth.protectConfigOwner, ctrl.listStates);

//Obtener Cities (con body id_configuracion, department_id, rate_type)
router.post('/location/cities', auth.protectConfigOwner, ctrl.listCities);

router.get(
  '/customer-history/:phone',
  auth.protectConfigOwner,
  ctrl.getCustomerHistory,
);

router.post('/client-stats', auth.protectConfigOwner, ctrl.getClientStats);

//Sync config
router.get('/sync-config', ...dropiboardGuard, ctrl.getSyncConfig);
router.put('/sync-config', ...dropiboardGuard, ctrl.updateSyncConfig);

router.get(
  '/all-my-integrations',
  ...dropiboardGuard,
  ctrl.listAllMyIntegrations,
);

// Dashboard: NO requiere protectConfigOwner porque soporta integraciones
// a nivel usuario (sin id_configuracion). Ownership se valida en el controller.
// Dashboard: requiere plan activo + valida tools_access en el controller
router.post('/dashboard/stats', ...dropiboardGuard, ctrl.getDashboardStats);

// Después de la ruta del dashboard:
router.post(
  '/dashboard/daily-metrics',
  ...dropiboardGuard,
  ctrl.getDailyMetrics,
);
router.put(
  '/dashboard/daily-metrics',
  ...dropiboardGuard,
  ctrl.upsertDailyMetric,
);
// FIX 2026-05-01 — detalle por producto de un día específico (drilldown)
router.post(
  '/dashboard/daily-detail-by-product',
  ...dropiboardGuard,
  ctrl.getDailyDetailByProduct,
);
// FIX 2026-05-01 (v3) — alertas de productos con problemas
router.post(
  '/dashboard/alertas-productos',
  ...dropiboardGuard,
  ctrl.getAlertasProductos,
);
// FIX 2026-05-01 (v3) — top ciudades con devoluciones
router.post(
  '/dashboard/ciudades-devoluciones',
  ...dropiboardGuard,
  ctrl.getCiudadesDevoluciones,
);
// FIX 2026-05-01 (v5) — rentabilidad por producto del rango
router.post(
  '/dashboard/productos-rentabilidad',
  ...dropiboardGuard,
  ctrl.getProductosRentabilidad,
);

// 2026-05-02 — Ciudades + Transportadoras (GET con query params)
router.get(
  '/dashboard/ciudades-transportadoras',
  ...dropiboardGuard,
  ctrl.getCiudadesTransportadoras,
);

// Dashboard por conexión (resumen KPIs + top productos)
router.post(
  '/dashboard/connection-summary',
  auth.protectConfigOwner,
  ctrl.getConnectionSummary,
);

module.exports = router;
