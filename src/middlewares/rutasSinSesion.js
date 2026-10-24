const jwt = require('jsonwebtoken');
const lotes = require('./rutasSinSesion.lotes.json');
const { protect } = require('./auth.middleware');

/*  Rutas REST que hoy no piden sesión (inventario del 24-oct-2026).
 *
 *  Hay ~180 rutas privadas sin `protect`: sin Bearer devuelven teléfonos,
 *  mandan plantillas o borran envíos programados. Ponerles `protect` de golpe
 *  rompería a quien las llame sin sesión sin que lo sepamos (otro sistema, un
 *  script), así que van por lotes y en dos tiempos:
 *
 *  1. Sombra: la petición pasa igual, pero se anota quién llegó sin sesión
 *     (`[RUTA_SIN_SESION]`). Un resumen cada 10 minutos.
 *  2. Exigir: el lote se pone en RUTAS_SESION_EXIGIR (ej. "A1,A2") y desde el
 *     próximo reinicio esas rutas pasan por `protect`. Quitarlo de la variable
 *     y reiniciar lo devuelve a sombra.
 *
 *  Los lotes están en rutasSinSesion.lotes.json. Los webhooks y las páginas
 *  públicas no están ahí a propósito.
 */

const CADA_MS = 10 * 60 * 1000;

function escapar(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function compilar(lote, entrada) {
  const [metodo, ruta] = entrada.split(' ');
  const segs = ruta.replace(/\/+$/, '').split('/');
  const params = segs.filter((s) => s.startsWith(':')).length;
  const rx = new RegExp(
    '^' + segs.map((s) => (s.startsWith(':') ? '[^/]+' : escapar(s))).join('/') + '/?$',
    'i', // Express no distingue mayúsculas en las rutas
  );
  return { lote, metodo, ruta, rx, params };
}

const REGLAS = Object.entries(lotes)
  .filter(([k]) => !k.startsWith('_'))
  .flatMap(([lote, lista]) => lista.map((e) => compilar(lote, e)))
  // Las rutas fijas ganan a las de parámetro, como en Express cuando la fija
  // va antes (`/cotizaciones/crm/x` antes que `/cotizaciones/:id_chat`).
  .sort((a, b) => a.params - b.params);

function exigidos(valor = process.env.RUTAS_SESION_EXIGIR) {
  return new Set(
    String(valor || '')
      .split(',')
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean),
  );
}

function buscar(metodo, path) {
  const m = metodo === 'HEAD' ? 'GET' : metodo;
  let p = path;
  try {
    p = decodeURIComponent(path);
  } catch (_) {
    // un % suelto: se compara tal cual
  }
  return REGLAS.find((r) => r.metodo === m && r.rx.test(p)) || null;
}

// Qué le diría protect a esta petición, sin ir a la base.
function clasificar(authorization) {
  if (!authorization || !authorization.startsWith('Bearer')) return 'TOKEN_MISSING';
  const token = authorization.split(' ')[1];
  if (!token) return 'TOKEN_MISSING';
  try {
    jwt.verify(token, process.env.SECRET_JWT_SEED);
    return null;
  } catch (err) {
    return err.name === 'TokenExpiredError' ? 'TOKEN_EXPIRED' : 'TOKEN_INVALID';
  }
}

function quien(req) {
  const ua = String(req.headers['user-agent'] || '-');
  // De un navegador no se guarda nada más; de un sistema, de dónde viene.
  if (/Mozilla/.test(ua)) return { cliente: 'navegador' };
  // Detrás de Apache req.ip es 127.0.0.1: la IP real va en X-Forwarded-For.
  const xff = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return { cliente: ua.slice(0, 80), ip: xff || req.ip };
}

const vistos = new Map();

function anotar(regla, code, req) {
  const q = quien(req);
  const clave = [regla.lote, regla.metodo, regla.ruta, code, q.cliente].join(' ');
  const fila = vistos.get(clave);
  if (fila) {
    fila.n += 1;
    return;
  }
  iniciarResumen();
  const nueva = { lote: regla.lote, metodo: regla.metodo, ruta: regla.ruta, code, ...q, n: 1 };
  vistos.set(clave, nueva);
  console.log('[RUTA_SIN_SESION] nueva', JSON.stringify(nueva));
}

function resumir() {
  if (!vistos.size) return;
  console.log('[RUTA_SIN_SESION] resumen', JSON.stringify([...vistos.values()]));
  vistos.clear();
}

let reloj = null;
function iniciarResumen() {
  if (reloj) return;
  reloj = setInterval(resumir, CADA_MS);
  reloj.unref?.();
}

const EXIGIDOS = exigidos();
console.log(
  '[RUTA_SIN_SESION] arranque',
  JSON.stringify({ reglas: REGLAS.length, exigidos: [...EXIGIDOS] }),
);

function vigilar(req, res, next) {
  const regla = buscar(req.method, req.path);
  if (!regla) return next();

  if (EXIGIDOS.has(regla.lote)) {
    const code = clasificar(req.headers.authorization);
    if (code) anotar(regla, code + '_RECHAZADO', req);
    return protect(req, res, next);
  }

  try {
    const code = clasificar(req.headers.authorization);
    if (code) anotar(regla, code, req);
  } catch (err) {
    // La sombra nunca frena una petición.
    console.warn('[RUTA_SIN_SESION] no se pudo anotar —', err.message);
  }
  next();
}

module.exports = { vigilar, buscar, clasificar, exigidos, REGLAS, resumir };
