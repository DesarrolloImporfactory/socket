const express = require('express');
const router = express.Router();

const { protect } = require('../middlewares/auth.middleware');
const espiaAcceso = require('../middlewares/espiaAcceso.middleware');
const { espiaAddon } = espiaAcceso;
const requireSuperAdmin = require('../middlewares/requireSuperAdmin.middleware');
const ctrl = require('../controllers/espia_mercado.controller');

/**
 * ImporKiller (Dropkiller propio; antes «Espía de mercado»): /api/v1/espia
 * Es GLOBAL: datos de mercado por país, no de una cuenta.
 *
 * Tres niveles (ver espiaAcceso.middleware):
 *   - plan activo (cualquier rol): buscador de productos, ficha, categorías,
 *     estado, reporte, seguir productos.
 *   - complemento ImporKiller ($10/mes) o super admin: la extensión de Chrome
 *     (/productos/lote) y todo lo de anuncios (Biblioteca de Meta, radar, tiendas).
 *   - super admin: correr el recolector, mandar el reporte, cuentas de mapeo.
 * La extensión usa la misma sesión (token del sub-usuario) para
 * /extension/ping, /anuncios, /tiendas/vista, /radar y /productos/lote.
 */
router.use(protect, espiaAcceso);

// ── Buscador de productos y métricas: todos ──
router.get('/estado', ctrl.estado);
router.get('/productos', ctrl.productos);
router.get('/productos/:pais/:id', ctrl.producto); // sin complemento, la ficha viene sin anuncios (anuncios_bloqueados)
router.get('/categorias', ctrl.categorias);
router.post('/seguir', ctrl.seguir);
router.get('/reporte', ctrl.reporte);
router.get('/extension/ping', ctrl.ping); // dice si la sesión tiene el complemento

// ── Complemento ImporKiller: extensión en Dropi + anuncios de Meta ──
router.post('/productos/lote', espiaAddon, ctrl.productosLote); // extensión en Dropi → métricas de hasta 200 ids
router.get('/anuncios', espiaAddon, ctrl.anuncios);
router.post('/anuncios', espiaAddon, ctrl.recibirAnuncios); // extensión → lote de hasta 200
router.get('/radar/cola', espiaAddon, ctrl.radarCola); // extensión → productos a buscar en Meta (con su término)
router.post('/radar/marcar', espiaAddon, ctrl.radarMarcar); // extensión → «busqué este producto; salieron estos anuncios»
router.post('/radar/latido', espiaAddon, ctrl.radarLatido); // extensión → «el radar está así» (la portada avisa si se pausa o se cae)
router.get('/tiendas', espiaAddon, ctrl.tiendas);
router.post('/tiendas/vista', espiaAddon, ctrl.vistaTienda); // extensión → «analicé esta tienda»
router.get('/tiendas/:dominio', espiaAddon, ctrl.tienda);

// ── Operar el recolector: solo Imporfactory ──
router.post('/reporte/enviar', requireSuperAdmin, ctrl.enviarReporte);
router.post('/extension/sesion-larga', requireSuperAdmin, ctrl.sesionLarga); // extensión del radar → token de 90 días que se renueva solo
router.post('/pasada', requireSuperAdmin, ctrl.pasada);

// Cuentas de Dropi (correo + token de integración) con las que se mapea cada
// país. Solo super admin; el token nunca sale (la lista trae token_last4).
router.get('/cuentas', requireSuperAdmin, ctrl.cuentas);
router.post('/cuentas', requireSuperAdmin, ctrl.guardarCuenta);
router.post('/cuentas/probar', requireSuperAdmin, ctrl.probarCuenta); // { id } o { pais, token }
router.patch('/cuentas/:id', requireSuperAdmin, ctrl.actualizarCuenta); // activa / etiqueta / token nuevo
router.delete('/cuentas/:id', requireSuperAdmin, ctrl.eliminarCuenta);

module.exports = router;
