const express = require('express');
const router = express.Router();

const { protect } = require('../middlewares/auth.middleware');
const espiaAcceso = require('../middlewares/espiaAcceso.middleware');
const requireSuperAdmin = require('../middlewares/requireSuperAdmin.middleware');
const ctrl = require('../controllers/espia_mercado.controller');

/**
 * Espía de mercado (Dropkiller propio): /api/v1/espia
 * Es GLOBAL: datos de mercado por país, no de una cuenta. Quién entra lo
 * decide espiaAcceso (hoy super administrador; cuando se venda a clientes se
 * abre por plan en checkToolAccess 'espia_mercado'). La extensión de Chrome
 * «Espía de tiendas» usa la misma sesión (token del sub-usuario) para
 * /extension/ping, /anuncios, /tiendas/vista y /productos/lote.
 */
router.use(protect, espiaAcceso);

router.get('/estado', ctrl.estado);
router.get('/productos', ctrl.productos);
router.post('/productos/lote', ctrl.productosLote); // extensión → métricas de hasta 200 ids
router.get('/productos/:pais/:id', ctrl.producto);
router.get('/categorias', ctrl.categorias);

router.get('/anuncios', ctrl.anuncios);
router.post('/anuncios', ctrl.recibirAnuncios); // extensión → lote de hasta 200
router.get('/radar/cola', ctrl.radarCola); // extensión → productos a buscar en Meta (con su término)
router.post('/radar/marcar', ctrl.radarMarcar); // extensión → «busqué este producto; salieron estos anuncios»

router.get('/tiendas', ctrl.tiendas);
router.post('/tiendas/vista', ctrl.vistaTienda); // extensión → «analicé esta tienda»
router.get('/tiendas/:dominio', ctrl.tienda);

router.post('/seguir', ctrl.seguir);

router.get('/reporte', ctrl.reporte);
// Operar el recolector y mandar el reporte sigue siendo solo de Imporfactory.
router.post('/reporte/enviar', requireSuperAdmin, ctrl.enviarReporte);
router.post('/pasada', requireSuperAdmin, ctrl.pasada);

router.get('/extension/ping', ctrl.ping);

module.exports = router;
