/*  Tapa los teléfonos de los clientes en lo que recibe un usuario con rol
 *  «equipo» (la pantalla de chat dentro de Team).
 *
 *  El teléfono no se oculta en la pantalla: no sale del servidor. Por eso esto
 *  recorre la respuesta entera (objetos, arrays, filas de Sequelize, JSON
 *  guardado como texto) y:
 *  - deja en «•••• 1234» toda clave que se llame como teléfono (celular,
 *    telefono*, phone*, whatsapp*, wa_id, uid_*) y todo número suelto de 12
 *    cifras con 593 o 52 delante;
 *  - quita el wamid, venga como clave o metido en cualquier texto, porque
 *    lleva el número en base64;
 *  - quita toda clave de llave o secreto (*token*, *secret*, api_key…);
 *  - en cualquier texto tapa los números del propio cliente, los que vienen
 *    detrás de «tel», «cel», «whatsapp», «+593», «+52» (D7) y los celulares
 *    de Ecuador (09…) o México (52…) aunque vayan solos. Una cédula de Guayas
 *    también empieza en 09 y se tapa; la de otra provincia o un número de
 *    guía se queda.
 *
 *  Los ids no se tocan: `celular_recibe` es el id del contacto, no un número.
 *  Devuelve una copia; nunca cambia el objeto que recibe.
 */

// Claves de teléfono: por patrón, para no depender de saber cada columna
// (celular, whatsapp_lead, telefono_conexion, sede_telefono…). Las de la
// lista de abajo se parecen pero son ids o banderas, no números.
const RX_CLAVE_TEL = /celular|tel[eé]fono|phone|whats?app|^wa_?id$|^uid_|^(from|to)$/i;
const NO_ES_TEL = new Set([
  'celular_recibe',
  'phone_number_id',
  'id_telefono',
  'id_phone',
  'business_phone_number_id',
  'telefono_verificado',
  'whatsapp_activo',
  'whatsapp_conectado',
  'tipo_telefono',
]);
const esClaveTel = (k) => RX_CLAVE_TEL.test(k) && !NO_ES_TEL.has(k) && (!/^id_|_id$|^es_|^tiene_|_activo$|_estado$/i.test(k) || /^wa_?id$/i.test(k));
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
// Llaves y secretos, también por patrón (page_access_token, refresh_token,
// openai_token, api_key…).
const RX_SECRETO = /token|secret|api_?key|password|^admin_pass$|^clave/i;
const CLAVES_JSON = new Set(['json_mensaje', 'meta_unificado', 'attachments_unificado', 'ruta_archivo']);

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

// Los números de la respuesta se buscan en un Set, tramo de cifras por tramo
// de cifras: con una expresión por número, 500 chats tardaban segundos y
// frenaban la API entera.
function rxDeNucleos(nucleos) {
  if (!nucleos.length) return null;
  return { set: new Set(nucleos), largos: [...new Set(nucleos.map((n) => n.length))] };
}
const RX_TRAMO = /\+?\d(?:[\s.\-]?\d){6,}/g;
function tieneNucleo(d, rx) {
  for (const L of rx.largos) {
    for (let k = 0; k + L <= d.length; k += 1) if (rx.set.has(d.substr(k, L))) return true;
  }
  return false;
}
// Celular de Ecuador (09 + 8 cifras) o México (10 cifras con 52/521 delante)
// aunque no venga «cel» ni «+593» delante. Una cédula de Guayas también empieza
// en 09: se tapa igual; es mejor tapar de más.
const RX_CEL_SUELTO = /(?<!\d)(?:593[\s.\-]?9\d(?:[\s.\-]?\d){7}|0?9\d(?:[\s.\-]?\d){7}|521?[\s.\-]?\d{2}(?:[\s.\-]?\d){8})(?!\d)/g;

function taparTexto(texto, nucleos, rx = rxDeNucleos(nucleos || [])) {
  if (typeof texto !== 'string' || !texto) return texto;
  let s = texto.includes('wamid.') ? texto.replace(RX_WAMID, '') : texto;
  if (!/\d(?:[\s.\-]?\d){6}/.test(s)) return s; // sin 7 cifras seguidas no hay teléfono
  // Primero el número del propio cliente, escrito como sea; se toma también lo
  // que va pegado delante (prefijo de país, 0) para no dejar cifras sueltas.
  if (rx) s = s.replace(RX_TRAMO, (m) => (tieneNucleo(soloCifras(m), rx) ? enmascararTelefono(m) : m));
  s = s.replace(RX_CLAVE_NUM, (_, pre, num) => pre + enmascararTelefono(num));
  s = s.replace(RX_PREFIJO, (m) => enmascararTelefono(m));
  s = s.replace(RX_CEL_SUELTO, (m) => enmascararTelefono(m));
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

// Un número suelto (no texto) que es un celular con prefijo de país:
// 5939XXXXXXXX o 52/521 + 10 cifras. Los ids nunca llegan a 12 cifras.
const RX_NUM_CEL = /^(?:5939\d{8}|521?\d{10})$/;

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
    if (esClaveTel(k) && (typeof x === 'string' || typeof x === 'number')) {
      if (CLAVES_AMBIGUAS.has(k) && !formaTel(x)) continue;
      const n = nucleo(x);
      if (n) out.add(n);
    } else if (typeof x === 'object') {
      juntarNucleos(x, out, vistos);
    }
  }
  return out;
}

function tapar(valor, rx, vistos) {
  const v = plano(valor);
  if (typeof v === 'string') return taparTexto(v, null, rx);
  if (typeof v === 'number') return RX_NUM_CEL.test(String(v)) ? enmascararTelefono(v) : v;
  if (!v || typeof v !== 'object') return v;
  if (v instanceof Date || Buffer.isBuffer(v)) return v;
  if (vistos.has(v)) return undefined; // ciclo: se corta
  vistos.add(v);

  if (Array.isArray(v)) {
    const r = v.map((x) => tapar(x, rx, vistos));
    vistos.delete(v);
    return r;
  }

  const r = {};
  for (const [k, x] of Object.entries(v)) {
    if (CLAVES_WAMID.has(k) || RX_SECRETO.test(k)) continue;
    if (esClaveTel(k) && (typeof x === 'string' || typeof x === 'number')) {
      r[k] = CLAVES_AMBIGUAS.has(k) && !formaTel(x) ? x : enmascararTelefono(x);
    } else if (CLAVES_JSON.has(k) && typeof x === 'string') {
      r[k] = taparJsonTexto(x, rx, vistos);
    } else {
      const t = tapar(x, rx, vistos);
      if (t !== undefined || x === undefined) r[k] = t;
    }
  }
  vistos.delete(v);
  return r;
}

function taparJsonTexto(texto, rx, vistos) {
  const t = texto.trim();
  if (t.startsWith('{') || t.startsWith('[')) {
    try {
      return JSON.stringify(tapar(JSON.parse(t), rx, vistos));
    } catch (_) {
      // no era JSON: se trata como texto
    }
  }
  return taparTexto(texto, null, rx);
}

function taparTelefonos(valor, { telefonosConocidos = [] } = {}) {
  const nucleos = juntarNucleos(valor);
  for (const t of telefonosConocidos) {
    const n = nucleo(t);
    if (n) nucleos.add(n);
  }
  return tapar(valor, rxDeNucleos([...nucleos]), new WeakSet());
}

module.exports = { taparTelefonos, enmascararTelefono, taparTexto, ROL_EQUIPO: 'equipo' };
