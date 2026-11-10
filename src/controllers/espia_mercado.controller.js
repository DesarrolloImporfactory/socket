const catchAsync = require('../utils/catchAsync');
const AppError = require('../utils/appError');
const espia = require('../services/espia_mercado.service');
const { ADDON_IMPORKILLER } = require('../middlewares/espiaAcceso.middleware');
const { generarToken } = require('../utils/jwt');
const jwt = require('jsonwebtoken');
const axios = require('axios');

/**
 * ImporKiller (Dropkiller propio; antes «Espía de mercado»). Quién entra lo
 * decide espiaAcceso (ver espia_mercado.routes.js), que deja en req.espia
 * qué puede ver cada uno. Respuestas { status:'success', data }.
 */
const ok = (res, data, code = 200) => res.status(code).json({ status: 'success', data });

// Lo que la pantalla y la extensión necesitan saber del que pregunta.
const accesoDe = (req) => {
  const a = req.espia || {};
  return {
    rol: a.rol || null,
    super_admin: !!a.super_admin,
    administrador: !!a.administrador,
    addon: !!a.addon,
    addon_comprado: !!a.addon_comprado,
    complemento: ADDON_IMPORKILLER,
  };
};

/**
 * Sesión larga para la extensión del radar (solo super administradores).
 * La sesión normal dura 7 días: en un equipo que queda barriendo Meta sin
 * nadie delante (la Mac mini), a la semana la extensión quedaba «sin sesión»
 * hasta que alguien volvía a iniciar sesión. La extensión cambia el token de
 * la web por uno de SESION_LARGA_DIAS con origen 'extension' y lo renueva
 * sola llamando aquí con ese mismo token cuando le quedan pocos días. Sigue
 * valiendo todo lo de sesionVigente (suspendido, cerrar sesión en Imporsuit).
 */
const SESION_LARGA_DIAS = 90;
exports.sesionLarga = catchAsync(async (req, res) => {
  const idSub = req.sessionUser?.id_sub_usuario;
  if (!idSub) throw new AppError('Sesión sin sub-usuario', 401);
  const token = await generarToken(idSub, { expiresIn: `${SESION_LARGA_DIAS}d`, extra: { origen: 'extension' } });
  const { exp } = jwt.decode(token) || {};
  return ok(res, { token, vence: exp ? new Date(exp * 1000).toISOString() : null, dias: SESION_LARGA_DIAS });
});

exports.estado = catchAsync(async (req, res) => {
  const est = await espia.estado(req.query.pais);
  est.acceso = accesoDe(req);
  if (req.espia?.super_admin) {
    // Estado del Chrome que barre Meta (la Mac del radar): pausa por verificación o sin señal.
    est.radar_equipo = await espia.radarEquipo().catch((e) => ({ ultimo: null, alerta: null, error: e.message }));
  }
  if (!req.espia?.super_admin) {
    // El cliente ve el mercado, no la operación: ni las cuentas de Dropi con
    // las que se fotografía el catálogo, ni páginas, errores, cron o freno del
    // recolector. De la pasada solo queda lo que alimenta sus indicadores.
    delete est.cuenta;
    delete est.cuentas;
    delete est.ultima_completa;
    delete est.cron_activo;
    delete est.fuente;
    delete est.freno_hasta;
    const u = est.ultima_pasada;
    est.ultima_pasada = u
      ? { estado: u.estado, inicio: u.inicio || null, fin: u.fin || null, ventas_sumadas: u.ventas_sumadas ?? null }
      : null;
  }
  return ok(res, est);
});

exports.productos = catchAsync(async (req, res) => ok(res, await espia.listarProductos(req.query)));

exports.producto = catchAsync(async (req, res) => {
  const d = await espia.detalleProducto(req.params.pais, req.params.id, { dias: req.query.dias });
  if (!req.espia?.addon) {
    // Los anuncios son del complemento: la ficha dice cuántos hay, no cuáles.
    d.anuncios_bloqueados = (d.anuncios || []).length;
    d.anuncios = [];
  }
  return ok(res, d);
});

exports.categorias = catchAsync(async (req, res) => ok(res, await espia.categorias(req.query.pais)));

// Extensión → métricas de los productos que el usuario tiene a la vista en Dropi.
exports.productosLote = catchAsync(async (req, res) =>
  ok(res, await espia.metricasLote(req.body?.pais || req.query.pais, req.body?.ids)),
);

exports.anuncios = catchAsync(async (req, res) => ok(res, await espia.listarAnuncios(req.query)));

/**
 * Descarga del creativo de un anuncio. Los archivos de Meta no se pueden bajar
 * directo desde la pantalla (otro dominio, sin permiso de descarga), así que
 * pasan por aquí como archivo adjunto. Si el video ya venció en Meta se
 * entrega la imagen; si no queda nada, 410 y la pantalla manda a la Biblioteca.
 * Sin redirecciones: solo se piden las direcciones que creativoDe validó.
 */
const MAX_CREATIVO = 300 * 1024 * 1024;
exports.creativo = catchAsync(async (req, res) => {
  const c = await espia.creativoDe(req.params.id);
  let origen = null;
  for (const url of c.urls) {
    try {
      origen = await axios.get(url, { responseType: 'stream', timeout: 30000, maxRedirects: 0, validateStatus: (s) => s === 200 });
      break;
    } catch {
      origen = null;
    }
  }
  if (!origen) throw new AppError('Este creativo ya no está disponible para descargar. Ábrelo en la Biblioteca de anuncios de Meta.', 410);
  const tipo = String(origen.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  const largo = Number(origen.headers['content-length']) || 0;
  if (!/^(video|image)\//.test(tipo) || largo > MAX_CREATIVO) {
    origen.data.destroy();
    throw new AppError('Este creativo no se puede descargar desde aquí. Ábrelo en la Biblioteca de anuncios de Meta.', 415);
  }
  const ext = tipo.startsWith('video/') ? 'mp4' : tipo.includes('png') ? 'png' : tipo.includes('webp') ? 'webp' : tipo.includes('gif') ? 'gif' : 'jpg';
  res.setHeader('Content-Type', tipo);
  if (largo) res.setHeader('Content-Length', String(largo));
  res.setHeader('Content-Disposition', `attachment; filename="anuncio-${c.id}.${ext}"`);
  res.setHeader('Cache-Control', 'private, max-age=600');
  origen.data.on('error', () => res.destroy());
  req.on('close', () => origen.data.destroy());
  origen.data.pipe(res);
});

exports.recibirAnuncios = catchAsync(async (req, res) =>
  ok(res, await espia.recibirAnuncios(req.body, req.sessionUser)),
);

// Radar (extensión): qué productos buscar en la Biblioteca y con qué palabras; y «ya busqué este».
exports.radarCola = catchAsync(async (req, res) => ok(res, await espia.radarCola(req.query, req.sessionUser)));
exports.radarMarcar = catchAsync(async (req, res) => ok(res, await espia.radarMarcar(req.body)));
exports.radarLatido = catchAsync(async (req, res) => ok(res, await espia.radarLatido(req.body, req.sessionUser)));

exports.tiendas = catchAsync(async (req, res) => ok(res, await espia.listarTiendas(req.query, req.sessionUser)));

exports.tienda = catchAsync(async (req, res) =>
  ok(res, await espia.detalleTienda(req.params.dominio, req.sessionUser)),
);

exports.vistaTienda = catchAsync(async (req, res) =>
  ok(res, await espia.registrarVistaTienda(req.body, req.sessionUser)),
);

exports.seguir = catchAsync(async (req, res) => ok(res, await espia.seguir(req.body, req.sessionUser)));

exports.reporte = catchAsync(async (req, res) => ok(res, await espia.reporte(req.query.pais)));

// Cuentas de Dropi con las que el recolector lee el catálogo (solo super admin).
// El token entra una vez, se guarda cifrado y nunca vuelve: la lista trae solo los 4 últimos.
exports.cuentas = catchAsync(async (req, res) => ok(res, await espia.listarCuentas(req.query.pais)));
exports.guardarCuenta = catchAsync(async (req, res) => ok(res, await espia.guardarCuenta(req.body, req.sessionUser), 201));
exports.actualizarCuenta = catchAsync(async (req, res) => ok(res, await espia.actualizarCuenta(req.params.id, req.body)));
exports.eliminarCuenta = catchAsync(async (req, res) => ok(res, await espia.eliminarCuenta(req.params.id)));
exports.probarCuenta = catchAsync(async (req, res) => ok(res, await espia.probarCuenta(req.body)));

exports.enviarReporte = catchAsync(async (req, res) =>
  ok(res, await espia.enviarReporteWhatsapp(req.body?.pais || req.query.pais)),
);

// Lanza una pasada en segundo plano y responde enseguida. En local (sin IP en
// la lista blanca de Dropi) solo funciona con ESPIA_MOCK_DIR o fuente 'mock'.
exports.pasada = catchAsync(async (req, res, next) => {
  const pais = String(req.body?.pais || req.query.pais || 'EC').toUpperCase();
  if (!espia.PAISES.includes(pais)) return next(new AppError(`País no soportado: ${pais}. Usa ${espia.PAISES_REALES.join(', ')}.`, 400));
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
  if (fuenteEfectiva !== 'mock' && est.cuenta?.error) return next(new AppError(est.cuenta.error, 400));
  espia
    .pasada(pais, { fuente, maxPaginas })
    .catch((e) => console.error('[espia-mercado] pasada manual falló:', e.message));
  return ok(res, { iniciada: true, pais, fuente: fuente || est.fuente }, 202);
});

// La extensión pregunta al instalarse y antes de cada envío: quién soy y si
// tengo el complemento (sin él, Dropi y la Biblioteca muestran cómo activarlo).
exports.ping = catchAsync(async (req, res) => {
  const acceso = accesoDe(req);
  return ok(res, {
    ok: true,
    usuario: {
      nombre: req.sessionUser?.nombre || req.sessionUser?.usuario || null,
      rol: acceso.rol,
      id_sub_usuario: req.sessionUser?.id_sub_usuario || null,
    },
    addon: { ...ADDON_IMPORKILLER, activo: acceso.addon, comprado: acceso.addon_comprado },
    acceso,
  });
});
