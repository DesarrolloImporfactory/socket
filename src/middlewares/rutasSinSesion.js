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
 *
 *  Límite de la sombra: solo mira que el JWT exista y esté firmado y vigente,
 *  sin ir a la base. Un usuario suspendido o con la sesión cerrada no aparece
 *  en la medición y al exigir recibirá 401, igual que en el resto de rutas.
 */

const CADA_MS = 10 * 60 * 1000;
// Tope de programas distintos por ruta en cada resumen: el user-agent lo elige
// quien llama, así que sin tope la memoria y el log crecerían a su gusto.
const MAX_CLIENTES = 10;
const POR_LINEA = 20;

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
  .filter((r) => r.ruta.startsWith('/'))
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

// Express compara la ruta SIN decodificar (y decodifica después cada
// parámetro), así que la comparación principal es con la ruta cruda. Además se
// prueba decodificando cada tramo por separado —nunca la ruta entera: un %2F
// dentro de un parámetro (`/cotizaciones/5%2Fx`) no debe convertirse en barra
// y dejar de encajar en `:id_chat`, que es justo lo que Express sí enruta.
function variantes(path) {
  const out = [path];
  const tramos = path.split('/').map((t) => {
    try {
      return decodeURIComponent(t).replace(/\//g, '_');
    } catch (_) {
      return t; // un % suelto: tal cual
    }
  });
  const dec = tramos.join('/');
  if (dec !== path) out.push(dec);
  return out;
}

function buscar(metodo, path) {
  const m = metodo === 'HEAD' ? 'GET' : metodo;
  const ps = variantes(String(path || ''));
  return REGLAS.find((r) => r.metodo === m && ps.some((p) => r.rx.test(p))) || null;
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
  // Detrás de Apache req.ip es 127.0.0.1. Apache AGREGA la IP real al final de
  // X-Forwarded-For; el primer valor lo puede inventar quien llama.
  const xff = String(req.headers['x-forwarded-for'] || '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
  const ip = xff.length ? xff[xff.length - 1] : req.ip;
  // Solo el primer «producto/versión» del user-agent: basta para saber qué
  // programa es y no deja que cada variante abra una fila nueva.
  const cliente = /Mozilla/.test(ua) ? 'navegador' : ua.split(/[\s;(]/)[0].slice(0, 40) || '-';
  return { cliente, ip };
}

// Una fila por lote+método+ruta+code (como mucho ~700: las reglas por los
// códigos posibles), siempre. El tope solo aplica a cuántos programas
// distintos se guardan por fila: así llenar el registro con user-agents
// falsos no esconde que otra ruta tuvo una llamada sin sesión.
const vistos = new Map();

function anotar(regla, code, req) {
  iniciarResumen();
  const q = quien(req);
  const clave = [regla.lote, regla.metodo, regla.ruta, code].join(' ');
  let fila = vistos.get(clave);
  if (!fila) {
    fila = { lote: regla.lote, metodo: regla.metodo, ruta: regla.ruta, code, n: 0, clientes: new Map(), otros: 0 };
    vistos.set(clave, fila);
  }
  fila.n += 1;
  const c = fila.clientes.get(q.cliente);
  if (c) {
    c.n += 1;
    return;
  }
  if (fila.clientes.size >= MAX_CLIENTES) {
    fila.otros += 1;
    return;
  }
  fila.clientes.set(q.cliente, { ip: q.ip, n: 1 });
  console.log(
    '[RUTA_SIN_SESION] nueva',
    JSON.stringify({ lote: regla.lote, metodo: regla.metodo, ruta: regla.ruta, code, ...q }),
  );
}

function resumir() {
  if (!vistos.size) return;
  const filas = [...vistos.values()].map((f) => ({
    lote: f.lote,
    metodo: f.metodo,
    ruta: f.ruta,
    code: f.code,
    n: f.n,
    clientes: Object.fromEntries(f.clientes),
    ...(f.otros ? { otros: f.otros } : {}),
  }));
  for (let i = 0; i < filas.length; i += POR_LINEA) {
    console.log('[RUTA_SIN_SESION] resumen', JSON.stringify(filas.slice(i, i + POR_LINEA)));
  }
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
