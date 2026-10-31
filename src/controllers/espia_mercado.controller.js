const catchAsync = require('../utils/catchAsync');
const AppError = require('../utils/appError');
const espia = require('../services/espia_mercado.service');

/**
 * Espía de mercado (Dropkiller propio). Todo con sesión de super administrador
 * (ver espia_mercado.routes.js). Respuestas { status:'success', data }.
 */
const ok = (res, data, code = 200) => res.status(code).json({ status: 'success', data });

exports.estado = catchAsync(async (req, res) => ok(res, await espia.estado(req.query.pais)));

exports.productos = catchAsync(async (req, res) => ok(res, await espia.listarProductos(req.query)));

exports.producto = catchAsync(async (req, res) =>
  ok(res, await espia.detalleProducto(req.params.pais, req.params.id, { dias: req.query.dias })),
);

exports.categorias = catchAsync(async (req, res) => ok(res, await espia.categorias(req.query.pais)));

// Extensión → métricas de los productos que el usuario tiene a la vista en Dropi.
exports.productosLote = catchAsync(async (req, res) =>
  ok(res, await espia.metricasLote(req.body?.pais || req.query.pais, req.body?.ids)),
);

exports.anuncios = catchAsync(async (req, res) => ok(res, await espia.listarAnuncios(req.query)));

exports.recibirAnuncios = catchAsync(async (req, res) =>
  ok(res, await espia.recibirAnuncios(req.body, req.sessionUser)),
);

// Radar (extensión): qué productos buscar en la Biblioteca y con qué palabras; y «ya busqué este».
exports.radarCola = catchAsync(async (req, res) => ok(res, await espia.radarCola(req.query, req.sessionUser)));
exports.radarMarcar = catchAsync(async (req, res) => ok(res, await espia.radarMarcar(req.body)));

exports.tiendas = catchAsync(async (req, res) => ok(res, await espia.listarTiendas(req.query, req.sessionUser)));

exports.tienda = catchAsync(async (req, res) =>
  ok(res, await espia.detalleTienda(req.params.dominio, req.sessionUser)),
);

exports.vistaTienda = catchAsync(async (req, res) =>
  ok(res, await espia.registrarVistaTienda(req.body, req.sessionUser)),
);

exports.seguir = catchAsync(async (req, res) => ok(res, await espia.seguir(req.body, req.sessionUser)));

exports.reporte = catchAsync(async (req, res) => ok(res, await espia.reporte(req.query.pais)));

exports.enviarReporte = catchAsync(async (req, res) =>
  ok(res, await espia.enviarReporteWhatsapp(req.body?.pais || req.query.pais)),
);

// Lanza una pasada en segundo plano y responde enseguida. En local (sin IP en
// la lista blanca de Dropi) solo funciona con ESPIA_MOCK_DIR o fuente 'mock'.
exports.pasada = catchAsync(async (req, res, next) => {
  const pais = String(req.body?.pais || req.query.pais || 'EC').toUpperCase();
  const fuente = req.body?.fuente === 'mock' ? 'mock' : undefined;
  const maxPaginas = Number(req.body?.max_paginas) || 0;
  const fuenteEfectiva = fuente || (process.env.ESPIA_MOCK_DIR ? 'mock' : 'dropi');
  if (pais === 'QA' && fuenteEfectiva !== 'mock') {
    return next(new AppError('QA solo acepta pasadas con respuestas guardadas (fuente mock, ESPIA_MOCK_DIR)', 400));
  }
  const est = await espia.estado(pais);
  if (est.corriendo) return next(new AppError(`Ya hay una pasada de ${pais} corriendo`, 409));
  if (est.freno_hasta) {
    return next(new AppError(`Recolector frenado por Dropi hasta ${new Date(est.freno_hasta).toLocaleString('es-EC')}`, 429));
  }
  espia
    .pasada(pais, { fuente, maxPaginas })
    .catch((e) => console.error('[espia-mercado] pasada manual falló:', e.message));
  return ok(res, { iniciada: true, pais, fuente: fuente || est.fuente }, 202);
});

exports.ping = catchAsync(async (req, res) =>
  ok(res, {
    ok: true,
    usuario: {
      nombre: req.sessionUser?.nombre || req.sessionUser?.usuario || null,
      rol: req.sessionUser?.rol || null,
      id_sub_usuario: req.sessionUser?.id_sub_usuario || null,
    },
  }),
);
