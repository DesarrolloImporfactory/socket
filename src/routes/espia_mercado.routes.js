const express = require('express');
const router = express.Router();

const { protect } = require('../middlewares/auth.middleware');
const requireSuperAdmin = require('../middlewares/requireSuperAdmin.middleware');
const ctrl = require('../controllers/espia_mercado.controller');

/**
 * Espía de mercado (Dropkiller propio): /api/v1/espia
 * Solo super administrador (Imporfactory). Es GLOBAL: datos de mercado por
 * país, no de una cuenta. La extensión de Chrome «Espía de tiendas» usa la
 * misma sesión (token del sub-usuario) para /extension/ping, /anuncios y
 * /tiendas/vista.
 */
router.use(protect, requireSuperAdmin);

router.get('/estado', ctrl.estado);
router.get('/productos', ctrl.productos);
router.get('/productos/:pais/:id', ctrl.producto);
router.get('/categorias', ctrl.categorias);

router.get('/anuncios', ctrl.anuncios);
router.post('/anuncios', ctrl.recibirAnuncios); // extensión → lote de hasta 200

router.get('/tiendas', ctrl.tiendas);
router.post('/tiendas/vista', ctrl.vistaTienda); // extensión → «analicé esta tienda»
router.get('/tiendas/:dominio', ctrl.tienda);

router.post('/seguir', ctrl.seguir);

router.get('/reporte', ctrl.reporte);
router.post('/reporte/enviar', ctrl.enviarReporte);
router.post('/pasada', ctrl.pasada);

router.get('/extension/ping', ctrl.ping);

module.exports = router;
