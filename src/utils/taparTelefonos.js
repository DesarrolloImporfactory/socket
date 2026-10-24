/*  Tapa los teléfonos de los clientes en lo que recibe un usuario con rol
 *  «equipo» (la pantalla de chat dentro de Team).
 *
 *  El teléfono no se oculta en la pantalla: no sale del servidor. Por eso esto
 *  recorre la respuesta entera (objetos, arrays, filas de Sequelize, JSON
 *  guardado como texto) y:
 *  - deja las claves de teléfono en «•••• 1234»;
 *  - quita el wamid, venga como clave o metido en cualquier texto, porque
 *    lleva el número en base64;
 *  - quita la llave de Meta (token, wa_token, access_token);
 *  - en los textos de los mensajes tapa los números del propio cliente y los
 *    que vienen detrás de «tel», «cel», «whatsapp», «+593», «+52»… (D7). Una
 *    cédula o un número de guía sin esas palabras se queda como está.
 *
 *  Los ids no se tocan: `celular_recibe` es el id del contacto, no un número.
 *  Devuelve una copia; nunca cambia el objeto que recibe.
 */

const CLAVES_TEL = new Set([
  'celular_cliente',
  'uid_cliente',
  'telefono_limpio',
  'uid_whatsapp',
  'telefono',
  'phone',
  'telefono_cliente',
  'telefono_orden',
  'telefono_sugerido',
  'phone_raw',
  'phone_normalizado',
  'celular_emisor',
  'celular_receptor',
  'to',
  'wa_id',
  'from',
]);
// Claves que también se usan para otras cosas (un rango de fechas «from»/«to»):
// se tapan solo si el valor tiene forma de teléfono.
const CLAVES_AMBIGUAS = new Set(['to', 'from']);
const RX_FORMA_TEL = /^\+?[\d\s.\-()]{7,20}$/;
const RX_FECHA = /^\d{4}-\d{1,2}-\d{1,2}|^\d{1,2}[/-]\d{1,2}[/-]\d{2,4}/;
function formaTel(x) {
  const t = String(x).trim();
  return RX_FORMA_TEL.test(t) && !RX_FECHA.test(t) && soloCifras(t).length >= 7;
}
const CLAVES_WAMID = new Set([
  'id_wamid_mensaje',
  'wamid',
  'context_wamid',
  'mid',
  'original_message_id',
]);
const CLAVES_SECRETO = new Set(['token', 'wa_token', 'access_token']);
const CLAVES_JSON = new Set(['json_mensaje', 'meta_unificado', 'attachments_unificado', 'ruta_archivo']);
const CLAVES_TEXTO = new Set(['texto_mensaje', 'texto_original', 'texto_corregido_mensaje', 'cliente']);

const MASCARA = '••••';
const RX_WAMID = /wamid\.[A-Za-z0-9_=+/-]+/g;
// Un número de teléfono escrito con espacios, puntos o guiones: 7 a 15 cifras.
const NUM = String.raw`\+?\d(?:[\s.\-]?\d){6,14}`;
const RX_CLAVE_NUM = new RegExp(
  String.raw`((?:tel[eé]?f?o?n?o?|cel(?:ular)?|whats?app|wsp|n[uú]mero|movil|móvil)\.?\s*[:#=]?\s*)(` + NUM + ')',
  'gi',
);
const RX_PREFIJO = new RegExp(String.raw`(?:\+|00)(?:593|52)(?:[\s.\-]?\d){7,11}`, 'g');

function soloCifras(v) {
  return String(v ?? '').replace(/\D/g, '');
}

function enmascararTelefono(t) {
  if (t === null || t === undefined || t === '') return t;
  const d = soloCifras(t);
  if (d.length < 4) return MASCARA;
  return `${MASCARA} ${d.slice(-4)}`;
}

// La parte del número que no cambia entre «0991234567», «593991234567» y
// «+593 99 123 4567»: las últimas 8 cifras.
function nucleo(t) {
  const d = soloCifras(t);
  return d.length >= 7 ? d.slice(-8) : null;
}

function rxDeNucleo(n) {
  return new RegExp(n.split('').join(String.raw`[\s.\-]?`), 'g');
}

function taparTexto(texto, nucleos) {
  if (typeof texto !== 'string' || !texto) return texto;
  let s = texto.replace(RX_WAMID, '');
  // Primero el número del propio cliente, escrito como sea; se toma también lo
  // que va pegado delante (prefijo de país, 0) para no dejar cifras sueltas.
  for (const n of nucleos) {
    s = s.replace(new RegExp(String.raw`(?:\+?\d{1,4}[\s.\-]?)?(?:0[\s.\-]?)?` + rxDeNucleo(n).source, 'g'), () =>
      enmascararTelefono(n),
    );
  }
  s = s.replace(RX_CLAVE_NUM, (_, pre, num) => pre + enmascararTelefono(num));
  s = s.replace(RX_PREFIJO, (m) => enmascararTelefono(m));
  return s;
}

function plano(v) {
  if (v && typeof v === 'object' && typeof v.toJSON === 'function' && !(v instanceof Date)) {
    try {
      return v.toJSON();
    } catch (_) {
      return v;
    }
  }
  return v;
}

// Junta los números de teléfono que aparecen en la respuesta, para tapar
// también esos mismos números cuando el cliente los escribe en un mensaje.
function juntarNucleos(valor, out = new Set(), vistos = new WeakSet()) {
  const v = plano(valor);
  if (!v || typeof v !== 'object') return out;
  if (vistos.has(v)) return out;
  vistos.add(v);
  if (Array.isArray(v)) {
    for (const x of v) juntarNucleos(x, out, vistos);
    return out;
  }
  for (const [k, x] of Object.entries(v)) {
    if (CLAVES_TEL.has(k) && (typeof x === 'string' || typeof x === 'number')) {
      if (CLAVES_AMBIGUAS.has(k) && !formaTel(x)) continue;
      const n = nucleo(x);
      if (n) out.add(n);
    } else if (typeof x === 'object') {
      juntarNucleos(x, out, vistos);
    }
  }
  return out;
}

function tapar(valor, nucleos, vistos) {
  const v = plano(valor);
  if (typeof v === 'string') return taparTexto(v, nucleos);
  if (!v || typeof v !== 'object') return v;
  if (v instanceof Date || Buffer.isBuffer(v)) return v;
  if (vistos.has(v)) return undefined; // ciclo: se corta
  vistos.add(v);

  if (Array.isArray(v)) {
    const r = v.map((x) => tapar(x, nucleos, vistos));
    vistos.delete(v);
    return r;
  }

  const r = {};
  for (const [k, x] of Object.entries(v)) {
    if (CLAVES_WAMID.has(k) || CLAVES_SECRETO.has(k)) continue;
    if (CLAVES_TEL.has(k) && (typeof x === 'string' || typeof x === 'number')) {
      r[k] = CLAVES_AMBIGUAS.has(k) && !formaTel(x) ? x : enmascararTelefono(x);
    } else if (CLAVES_JSON.has(k) && typeof x === 'string') {
      r[k] = taparJsonTexto(x, nucleos, vistos);
    } else if (CLAVES_TEXTO.has(k) && typeof x === 'string') {
      r[k] = taparTexto(x, nucleos);
    } else {
      const t = tapar(x, nucleos, vistos);
      if (t !== undefined || x === undefined) r[k] = t;
    }
  }
  vistos.delete(v);
  return r;
}

function taparJsonTexto(texto, nucleos, vistos) {
  const t = texto.trim();
  if (t.startsWith('{') || t.startsWith('[')) {
    try {
      return JSON.stringify(tapar(JSON.parse(t), nucleos, vistos));
    } catch (_) {
      // no era JSON: se trata como texto
    }
  }
  return taparTexto(texto, nucleos);
}

function taparTelefonos(valor, { telefonosConocidos = [] } = {}) {
  const nucleos = juntarNucleos(valor);
  for (const t of telefonosConocidos) {
    const n = nucleo(t);
    if (n) nucleos.add(n);
  }
  return tapar(valor, [...nucleos], new WeakSet());
}

module.exports = { taparTelefonos, enmascararTelefono, taparTexto, ROL_EQUIPO: 'equipo' };
