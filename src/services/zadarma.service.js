/**
 * Telefonía por saldo con Zadarma (llamadas a celular/fijo, sin WhatsApp).
 *
 * Modelo: UNA cuenta maestra de Imporfactory en Zadarma (llaves en .env:
 * ZADARMA_USER_KEY / ZADARMA_SECRET_KEY). En su central (PBX) hay extensiones
 * 100, 101, … Cada asesor recibe una extensión; el widget WebRTC de Zadarma la
 * registra en su navegador. Para llamar a un cliente usamos el "callback":
 * Zadarma primero hace sonar la extensión (el widget) y, cuando el asesor
 * contesta, marca al cliente. Lo que el cliente ve en pantalla es el CallerID
 * de la extensión, que ponemos justo antes de llamar con el número verificado
 * de la conexión (telefonia_cuentas.caller_id).
 *
 * El saldo por conexión es libro nuestro: telefonia_cuentas + movimientos.
 * El consumo real lo escribe el webhook NOTIFY_OUT_END con los segundos.
 *
 * API (https://zadarma.com/en/support/api/):
 *   - Firma: Authorization: <user_key>:<base64(hmac_sha1(method + query + md5(query), secret))>
 *     con los parámetros ordenados alfabéticamente y codificados como
 *     http_build_query de PHP (espacios como "+").
 *   - GET  /v1/info/balance/            saldo de la cuenta maestra
 *   - GET  /v1/sip/                     números SIP de la cuenta
 *   - GET  /v1/pbx/internal/            extensiones de la central
 *   - PUT  /v1/pbx/internal/<ext>/callerid/   { number }
 *   - PUT  /v1/pbx/internal/recording/  { status: 'on', … } (grabación)
 *   - POST /v1/webrtc/get_key/          { sip } → llave del widget (72 h)
 *   - GET  /v1/request/callback/        ?from=<ext>&to=<numero>
 *   - POST /v1/pbx/callinfo/url/        { url } → URL de webhooks (valida zd_echo)
 *   - GET  /v1/pbx/record/request/      ?call_id=…&lifetime=… → enlace grabación
 * Webhooks (POST form-urlencoded, cabecera Signature):
 *   NOTIFY_OUT_START / NOTIFY_OUT_END: firma = base64(hmac_sha1(internal + destination + call_start, secret))
 *   NOTIFY_START / NOTIFY_END / NOTIFY_ANSWER: firma = base64(hmac_sha1(caller_id + called_did + call_start, secret))
 *   NOTIFY_RECORD: firma = base64(hmac_sha1(pbx_call_id + call_id_with_rec, secret))
 */
const crypto = require('crypto');
const axios = require('axios');
const { Op } = require('sequelize');
const { db } = require('../database/config');
const ClientesChatCenter = require('../models/clientes_chat_center.model');
const Configuraciones = require('../models/configuraciones.model');
const TelefoniaLlamadas = require('../models/telefonia_llamadas.model');
const TelefoniaExtensiones = require('../models/telefonia_extensiones.model');
const TelefoniaCuentas = require('../models/telefonia_cuentas.model');
const TelefoniaMovimientos = require('../models/telefonia_movimientos.model');
const TelefoniaMaestra = require('../models/telefonia_maestra.model');
const TelefoniaNumeros = require('../models/telefonia_numeros.model');
const { encryptToken, decryptToken, last4 } = require('../utils/cryptoToken');
const { emitirA, notificarEnChat } = require('./llamadas_whatsapp.service');
const fs = require('fs').promises;
const path = require('path');

const BASE = 'https://api.zadarma.com';

/* ── Credenciales de la cuenta maestra ──
   Primero la fila de telefonia_maestra (la guarda el super admin desde la
   pantalla /telefonia); si no hay, el .env. Se cachean en memoria y se
   recargan al guardar. */
let cred = { user_key: '', secret: '', sip_principal: '', cargadas_at: 0 };
const CRED_TTL_MS = 60_000;

async function cargarCredenciales(forzar = false) {
  if (!forzar && Date.now() - cred.cargadas_at < CRED_TTL_MS) return cred;
  let fila = null;
  try {
    fila = await TelefoniaMaestra.findByPk(1);
  } catch (e) {
    if (!/doesn't exist/i.test(e?.message || '')) throw e;
  }
  if (fila) {
    let secret = '';
    try {
      secret = decryptToken(fila.secret_enc);
    } catch (e) {
      console.error('[telefonia] no se pudo descifrar la llave secreta:', e.message);
    }
    cred = { user_key: fila.user_key, secret, sip_principal: fila.sip_principal || '', cargadas_at: Date.now() };
  } else {
    cred = {
      user_key: process.env.ZADARMA_USER_KEY || '',
      secret: process.env.ZADARMA_SECRET_KEY || '',
      sip_principal: process.env.ZADARMA_SIP_PRINCIPAL || '',
      cargadas_at: Date.now(),
    };
  }
  return cred;
}

const KEY = () => cred.user_key || '';
const SECRET = () => cred.secret || '';
const configurado = () => !!(KEY() && SECRET());

/** Guarda las llaves (secreta cifrada), las prueba contra /v1/info/balance/
 *  y devuelve el saldo. Si Zadarma las rechaza, no se guardan. */
async function guardarCredenciales({ user_key, secret, sip_principal = null, id_sub_usuario = null }) {
  const anterior = { ...cred };
  cred = { user_key: String(user_key).trim(), secret: String(secret).trim(), sip_principal: sip_principal || '', cargadas_at: Date.now() };
  sipPrincipalCache = null;
  let saldo;
  try {
    saldo = await balance();
  } catch (e) {
    cred = anterior;
    const err = new Error(`Zadarma rechazó las llaves: ${e.message}`);
    err.status = 400;
    throw err;
  }
  await TelefoniaMaestra.upsert({
    id: 1,
    user_key: cred.user_key,
    secret_enc: encryptToken(cred.secret),
    secret_last4: last4(cred.secret),
    sip_principal: cred.sip_principal || null,
    actualizado_por: id_sub_usuario,
    updated_at: new Date(),
  });
  return saldo;
}

async function estadoCredenciales() {
  await cargarCredenciales(true);
  let fila = null;
  try {
    fila = await TelefoniaMaestra.findByPk(1);
  } catch {
    fila = null;
  }
  return {
    configurada: configurado(),
    origen: fila ? 'pantalla' : configurado() ? 'env' : null,
    user_key: KEY() ? `${KEY().slice(0, 4)}…${KEY().slice(-4)}` : null,
    secret_last4: fila?.secret_last4 || (SECRET() ? SECRET().slice(-4) : null),
    sip_principal: cred.sip_principal || null,
    webhook_url: fila?.webhook_url || null,
    webhook_instalado_at: fila?.webhook_instalado_at || null,
  };
}

/* ── Firma ─────────────────────────────────────────────────────────────── */

/** urlencode de PHP: como encodeURIComponent pero con "+" para el espacio y
 *  codificando también ! ' ( ) * (RFC 1738). */
const phpUrlencode = (v) =>
  encodeURIComponent(String(v))
    .replace(/%20/g, '+')
    .replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/** http_build_query con las claves ordenadas (ksort). */
function construirQuery(params = {}) {
  return Object.keys(params)
    .filter((k) => params[k] !== undefined && params[k] !== null)
    .sort()
    .map((k) => `${phpUrlencode(k)}=${phpUrlencode(params[k])}`)
    .join('&');
}

/** base64 del HMAC-SHA1 **en hexadecimal**, como hace PHP: hash_hmac()
 *  devuelve hex y base64_encode() codifica ese texto, no los bytes crudos.
 *  Con digest('base64') directo Zadarma responde "Not authorized". */
const hmacBase64 = (texto) =>
  Buffer.from(
    crypto.createHmac('sha1', SECRET()).update(String(texto)).digest('hex'),
  ).toString('base64');

function firmar(method, params = {}) {
  const query = construirQuery(params);
  const md5 = crypto.createHash('md5').update(query).digest('hex');
  return { query, authorization: `${KEY()}:${hmacBase64(`${method}${query}${md5}`)}` };
}

/** Llamada firmada a la API. `method` es la ruta, p. ej. '/v1/info/balance/'. */
async function api(method, params = {}, httpMethod = 'GET') {
  await cargarCredenciales();
  if (!configurado()) {
    const e = new Error('Zadarma no está configurado (ZADARMA_USER_KEY / ZADARMA_SECRET_KEY)');
    e.status = 503;
    throw e;
  }
  const { query, authorization } = firmar(method, params);
  /* Como el cliente oficial (user-api-v1/lib/Client.php): solo GET lleva
     los parámetros en la URL; POST, PUT y DELETE los mandan en el cuerpo.
     Con DELETE en la URL Zadarma respondía "Not authorized" (la firma se
     calcula sobre el cuerpo), y el borrado de grabaciones no funcionaba. */
  const esGet = httpMethod === 'GET';
  const url = `${BASE}${method}${esGet && query ? `?${query}` : ''}`;
  const r = await axios({
    method: httpMethod,
    url,
    data: esGet ? undefined : query,
    headers: {
      Authorization: authorization,
      ...(esGet ? {} : { 'Content-Type': 'application/x-www-form-urlencoded' }),
    },
    timeout: 20000,
    validateStatus: () => true,
  });
  const data = r.data || {};
  if (r.status >= 400 || data.status === 'error') {
    const e = new Error(data.message || `Zadarma respondió ${r.status} en ${method}`);
    e.status = 502;
    e.zadarma = data;
    throw e;
  }
  return data;
}

/* ── Cuenta maestra ────────────────────────────────────────────────────── */

async function balance() {
  const d = await api('/v1/info/balance/');
  return { balance: Number(d.balance), currency: d.currency };
}

/** Prefijo del login SIP de las extensiones: el id de la central (pbx_id),
 *  p. ej. extensión 100 de la central 341640 → "341640-100". Los números de
 *  /v1/sip/ son cuentas SIP sueltas, no sirven de prefijo. Se puede forzar
 *  desde la pantalla (sip_principal). */
let sipPrincipalCache = null;
async function sipPrincipal() {
  await cargarCredenciales();
  if (cred.sip_principal) return cred.sip_principal;
  if (sipPrincipalCache) return sipPrincipalCache;
  const { pbx_id } = await extensionesCentral();
  if (!pbx_id) throw new Error('La cuenta de Zadarma no tiene central (Mi PBX) activa');
  sipPrincipalCache = String(pbx_id);
  return sipPrincipalCache;
}

/** Extensiones de la central: { pbx_id, numbers: ['100', '101', …] }. */
async function extensionesCentral() {
  const d = await api('/v1/pbx/internal/');
  return {
    pbx_id: d.pbx_id ? String(d.pbx_id) : null,
    numbers: (d.numbers || []).map(String),
  };
}

/* ── Extensión por asesor ──────────────────────────────────────────────── */

async function nombreSubUsuario(id_sub_usuario) {
  const [su] = await db.query(
    `SELECT nombre_encargado FROM sub_usuarios_chat_center WHERE id_sub_usuario = ? LIMIT 1`,
    { replacements: [id_sub_usuario], type: db.QueryTypes.SELECT },
  );
  return su?.nombre_encargado || `Asesor ${id_sub_usuario}`;
}

/** Devuelve la extensión del asesor; si no tiene, le asigna la primera libre
 *  de la central. Si no quedan libres, hay que crear más en "Mi PBX". */
/* Las extensiones de la central se cachean un minuto: se consultan en cada
   apertura del teléfono y Zadarma limita las llamadas a la API. */
let centralCache = { numbers: null, at: 0 };
async function numerosCentral() {
  if (centralCache.numbers && Date.now() - centralCache.at < 60_000) return centralCache.numbers;
  const { numbers } = await extensionesCentral();
  centralCache = { numbers, at: Date.now() };
  return numbers;
}

/** Minutos sin uso tras los cuales una extensión se puede dar a otro asesor. */
const MIN_INACTIVIDAD_RECICLAR = 15;

/**
 * Extensión del asesor. Hay pocas (el plan incluye 5) y muchos asesores, así
 * que se asignan al que de verdad va a llamar y se reciclan:
 *   1. Si ya tiene una y sigue existiendo en la central, se le refresca el
 *      último uso y se devuelve. Si la borraron en Zadarma (pasó con la 101:
 *      "It's not your SIP"), se olvida y se busca otra.
 *   2. Si hay una libre en la central, se asigna.
 *   3. Si no, se le quita a quien lleve más de 15 min sin usarla y no esté
 *      en una llamada; a ese asesor se le avisa por socket para que su
 *      teléfono se desregistre.
 *   4. Si todas están en uso reciente, error 409 (se muestra solo al
 *      intentar llamar, no al abrir el chat).
 */
async function asegurarExtension(id_sub_usuario) {
  const numbers = await numerosCentral();
  const ahora = new Date();
  const actual = await TelefoniaExtensiones.findOne({ where: { id_sub_usuario } });
  if (actual) {
    if (numbers.includes(String(actual.extension))) {
      await actual.update({ ultimo_uso_at: ahora });
      return actual;
    }
    console.warn(`[telefonia] la extensión ${actual.extension} ya no existe en la central; se reasigna al asesor ${id_sub_usuario}`);
    await actual.destroy();
  }
  const sip = await sipPrincipal();
  const asignadas = await TelefoniaExtensiones.findAll({ order: [['ultimo_uso_at', 'ASC']] });
  const usadas = new Set(asignadas.map((e) => String(e.extension)));
  let libre = numbers.find((n) => !usadas.has(String(n)));
  if (!libre) {
    const limite = new Date(Date.now() - MIN_INACTIVIDAD_RECICLAR * 60_000);
    for (const e of asignadas) {
      if (!numbers.includes(String(e.extension))) {
        await e.destroy(); // extensión borrada en Zadarma: la fila sobra
        continue;
      }
      if (e.ultimo_uso_at && new Date(e.ultimo_uso_at) > limite) continue;
      const [enLlamada] = await db.query(
        `SELECT id FROM telefonia_llamadas WHERE id_sub_usuario = ? AND fin_at IS NULL AND inicio_at > DATE_SUB(NOW(), INTERVAL 30 MINUTE) LIMIT 1`,
        { replacements: [e.id_sub_usuario], type: db.QueryTypes.SELECT },
      );
      if (enLlamada) continue;
      libre = String(e.extension);
      const anterior = e.id_sub_usuario;
      await e.destroy();
      emitirA([anterior], 'TELEFONIA_EXTENSION_LIBERADA', { extension: libre });
      console.log(`[telefonia] extensión ${libre} reciclada: del asesor ${anterior} al ${id_sub_usuario}`);
      break;
    }
  }
  if (!libre) {
    const e = new Error(
      `Todas las extensiones de Zadarma están en uso por otros asesores (${numbers.length} en total). Intenta en unos minutos o pide que creen más en Mi centralita → Extensiones.`,
    );
    e.status = 409;
    e.code = 'SIN_EXTENSION';
    throw e;
  }
  return TelefoniaExtensiones.create({
    id_sub_usuario,
    extension: libre,
    sip_login: `${sip}-${libre}`,
    ultimo_uso_at: ahora,
  });
}

/** Llave del widget WebRTC del asesor (Zadarma la da por 72 h; se renueva
 *  con margen de 12 h). */
async function llaveWidget(id_sub_usuario) {
  const ext = await asegurarExtension(id_sub_usuario);
  const vigente =
    ext.widget_key && ext.widget_key_vence_at && new Date(ext.widget_key_vence_at) > new Date();
  if (!vigente) {
    let d;
    try {
      d = await api('/v1/webrtc/get_key/', { sip: ext.sip_login }, 'GET');
    } catch (e) {
      // "It's not your SIP": la extensión se borró en Zadarma después de
      // asignarla. Se olvida la fila, se vacía el caché y se reintenta una vez.
      if (!/not your sip/i.test(e.message || '')) throw e;
      await ext.destroy();
      centralCache = { numbers: null, at: 0 };
      const otra = await asegurarExtension(id_sub_usuario);
      d = await api('/v1/webrtc/get_key/', { sip: otra.sip_login }, 'GET');
      const key2 = d.key || d.data?.key;
      if (!key2) throw new Error('Zadarma no devolvió la llave del widget');
      await otra.update({ widget_key: key2, widget_key_vence_at: new Date(Date.now() + 60 * 3600 * 1000) });
      return { key: key2, sip: otra.sip_login, extension: otra.extension };
    }
    const key = d.key || d.data?.key;
    if (!key) throw new Error('Zadarma no devolvió la llave del widget');
    await ext.update({
      widget_key: key,
      widget_key_vence_at: new Date(Date.now() + 60 * 3600 * 1000),
    });
  }
  return { key: ext.widget_key, sip: ext.sip_login, extension: ext.extension };
}

/* ── Costo real por minuto (para avisar si la tarifa no es rentable) ──
   Zadarma cobra según el destino; se consulta con un número de muestra a
   celular del país de la conexión y se cachea una hora. */
const MUESTRA_POR_PAIS = { ec: '593990000000', co: '573000000000', mx: '5215500000000', pe: '519000000000', gt: '50250000000', us: '13050000000' };
const costoCache = new Map(); // pais → { centavos, descripcion, at }
/** Costo de Zadarma por minuto (en centavos, con decimales) hacia un número
 *  concreto. Se cachea 6 h por los primeros 6 dígitos, que es lo que define
 *  país y operadora. null si Zadarma no responde. */
const costoDestinoCache = new Map(); // prefijo → { centavos, at }
async function costoDestino(numero) {
  const n = soloDigitos(numero);
  if (n.length < 8) return null;
  const pref = n.slice(0, 6);
  const c = costoDestinoCache.get(pref);
  if (c && Date.now() - c.at < 6 * 3600_000) return c.centavos;
  try {
    const d = await api('/v1/info/price/', { number: n });
    const centavos = Number(d.info?.price) * 100;
    if (!Number.isFinite(centavos)) return null;
    costoDestinoCache.set(pref, { centavos, at: Date.now() });
    return centavos;
  } catch {
    return null;
  }
}

async function costoReferencia(pais = 'ec') {
  const key = String(pais || 'ec').toLowerCase();
  const c = costoCache.get(key);
  if (c && Date.now() - c.at < 3600_000) return c;
  const numero = MUESTRA_POR_PAIS[key] || MUESTRA_POR_PAIS.ec;
  const d = await api('/v1/info/price/', { number: numero });
  const out = {
    pais: key,
    centavos_min: Math.round(Number(d.info?.price || 0) * 100),
    descripcion: d.info?.description || '',
    currency: d.info?.currency || 'USD',
    at: Date.now(),
  };
  costoCache.set(key, out);
  return out;
}

/* ── Saldo por conexión ────────────────────────────────────────────────── */

/** Cuenta telefónica de una conexión. Solo se CREA cuando el super admin le
 *  da saldo o la configura (crear = true); una consulta desde el chat nunca
 *  crea nada, así el botón "Llamar al celular" no aparece en conexiones a
 *  las que nadie les asignó telefonía. */
async function cuentaDe(id_configuracion, { crear = false } = {}) {
  if (!crear) return TelefoniaCuentas.findByPk(id_configuracion);
  const [cuenta] = await TelefoniaCuentas.findOrCreate({
    where: { id_configuracion },
    defaults: { saldo_centavos: 0, tarifa_centavos_min: 40, activo: 1 },
  });
  return cuenta;
}

/** ¿La cuenta (id_usuario) tiene alguna conexión con telefonía activa? Decide
 *  si al asesor se le carga el widget y se le asigna extensión. */
async function cuentaTieneTelefonia(id_usuario) {
  const [row] = await db.query(
    `SELECT 1 AS hay FROM telefonia_cuentas tc
     INNER JOIN configuraciones c ON c.id = tc.id_configuracion
     WHERE c.id_usuario = ? AND tc.activo = 1 LIMIT 1`,
    { replacements: [id_usuario], type: db.QueryTypes.SELECT },
  );
  return !!row;
}

async function movimiento({ id_configuracion, tipo, centavos, id_llamada = null, id_sub_usuario = null, detalle = null }) {
  const cuenta = await cuentaDe(id_configuracion, { crear: true });
  const nuevo = Number(cuenta.saldo_centavos) + Number(centavos);
  await cuenta.update({ saldo_centavos: nuevo, updated_at: new Date() });
  await TelefoniaMovimientos.create({
    id_configuracion,
    tipo,
    centavos,
    saldo_despues_centavos: nuevo,
    id_llamada,
    id_sub_usuario,
    detalle,
  });
  return nuevo;
}

const recargar = (id_configuracion, centavos, id_sub_usuario, detalle) =>
  movimiento({ id_configuracion, tipo: 'recarga', centavos: Math.abs(centavos), id_sub_usuario, detalle });

/** Quita saldo a una conexión (hasta dejarla en cero): libera la cobertura
 *  en Zadarma, por ejemplo al terminar pruebas o si se cargó de más. */
async function retirar(id_configuracion, centavos, id_sub_usuario, detalle) {
  const cuenta = await cuentaDe(id_configuracion, { crear: true });
  const monto = Math.min(Math.abs(centavos), Number(cuenta.saldo_centavos));
  if (monto <= 0) return Number(cuenta.saldo_centavos);
  return movimiento({ id_configuracion, tipo: 'retiro', centavos: -monto, id_sub_usuario, detalle });
}

/** Centavos que cuesta una llamada de N segundos a la tarifa de la cuenta
 *  (cobro por segundo, redondeado hacia arriba al centavo). */
const costoCentavos = (segundos, tarifaMin) => Math.ceil((Math.max(0, segundos) * tarifaMin) / 60);

/* ── Llamar ────────────────────────────────────────────────────────────── */

const soloDigitos = (t) => String(t || '').replace(/\D/g, '');

/** modo 'directo': el navegador del asesor marca con el widget de Zadarma
 *  (una sola pierna, sin timbre previo). modo 'callback': Zadarma llama a la
 *  extensión y luego al cliente (por si el navegador no tiene micrófono). */
async function llamar({ id_configuracion, id_cliente, id_sub_usuario, modo = 'directo' }) {
  const cliente = await ClientesChatCenter.findByPk(id_cliente);
  if (!cliente || Number(cliente.id_configuracion) !== Number(id_configuracion)) {
    const e = new Error('El chat no es de esta conexión');
    e.status = 404;
    throw e;
  }
  const destino = soloDigitos(cliente.celular_cliente);
  if (destino.length < 8) {
    const e = new Error('El contacto no tiene un número telefónico válido');
    e.status = 400;
    throw e;
  }
  const cuenta = await cuentaDe(id_configuracion);
  if (!cuenta || !cuenta.activo) {
    const e = new Error('La telefonía está desactivada en esta conexión');
    e.status = 403;
    throw e;
  }
  /* Precio por minuto hacia ESTE destino: costo de Zadarma para ese número
     por el margen de la conexión. Sirve para exigir un minuto de saldo y
     para que el teléfono del asesor sepa cuándo cortar por saldo (a México
     alcanza para muchos más minutos que a Ecuador). Si no se puede
     consultar, se usa el precio fijo de la conexión. */
  let tarifaDestino = Number(cuenta.tarifa_centavos_min);
  try {
    const [costo, factor] = await Promise.all([costoDestino(destino), margenDe(cuenta, id_configuracion)]);
    if (costo != null && factor != null) tarifaDestino = Math.max(0.01, costo * factor);
  } catch {
    /* se queda el precio fijo */
  }
  // Mínimo un minuto de saldo para arrancar; el consumo real va por segundo.
  if (Number(cuenta.saldo_centavos) < Math.ceil(tarifaDestino)) {
    const e = new Error('Saldo insuficiente para llamar. Recarga para continuar.');
    e.status = 402;
    e.code = 'SIN_SALDO';
    throw e;
  }
  const ext = await asegurarExtension(id_sub_usuario);

  // Sale con el número propio de la conexión solo si Zadarma lo tiene
  // verificado; si no, se limpia el CallerID de la extensión (que pudo
  // quedar con el número de otro cliente) y la llamada sale "desconocida".
  let callerIdUsado = null;
  if (cuenta.caller_id) {
    try {
      await api(`/v1/pbx/internal/${ext.extension}/callerid/`, { number: soloDigitos(cuenta.caller_id) }, 'PUT');
      callerIdUsado = soloDigitos(cuenta.caller_id);
    } catch (e) {
      console.warn(`[telefonia] CallerID ${cuenta.caller_id} rechazado por Zadarma (cfg ${id_configuracion}): ${e.message}`);
      await TelefoniaNumeros.upsert({ id_configuracion, numero: soloDigitos(cuenta.caller_id), verificado: 0, detalle: e.message, comprobado_at: new Date() }).catch(() => {});
    }
  }
  if (!callerIdUsado) {
    await api(`/v1/pbx/internal/${ext.extension}/callerid/`, {}, 'DELETE').catch(() => {});
  }

  /* Una fila "pedida" sin pbx_call_id es una llamada que el navegador nunca
     marcó (el widget estaba desregistrado, el asesor cerró la pestaña…).
     Zadarma jamás avisará de ella, así que se cierra como "no_marco" antes
     de abrir la nueva; si no, quedan abiertas para siempre y confunden al
     webhook (busca la última sin cerrar de esa extensión y destino). */
  await TelefoniaLlamadas.update(
    { estado: 'failed', disposition: 'no_marco', fin_at: new Date(), duracion_seg: 0, costo_centavos: 0 },
    { where: { id_sub_usuario, estado: 'pedida', pbx_call_id: null, inicio_at: { [Op.lt]: new Date(Date.now() - 60_000) } } },
  );

  const fila = await TelefoniaLlamadas.create({
    id_configuracion,
    id_cliente_chat_center: cliente.id,
    id_sub_usuario,
    extension: ext.extension,
    telefono_cliente: destino,
    caller_id: callerIdUsado,
    estado: 'pedida',
    inicio_at: new Date(),
  });

  if (modo === 'callback') {
    try {
      await api('/v1/request/callback/', { from: ext.extension, to: destino });
    } catch (e) {
      await fila.update({ estado: 'failed', disposition: e.message, fin_at: new Date() });
      throw e;
    }
  }
  emitirA([id_sub_usuario], 'TELEFONIA_ESTADO', {
    id: fila.id,
    estado: 'pedida',
    telefono: destino,
    id_cliente_chat_center: cliente.id,
  });
  return {
    id: fila.id,
    modo,
    extension: ext.extension,
    telefono: destino,
    caller_id: callerIdUsado,
    saldo_centavos: cuenta.saldo_centavos,
    tarifa_centavos_min: cuenta.tarifa_centavos_min,
    // Precio estimado por minuto hacia este destino (para el corte por saldo).
    tarifa_destino_centavos_min: Math.round(tarifaDestino * 100) / 100,
  };
}

/** ¿Esta conexión tiene telefonía activa? */
async function conexionTieneTelefonia(id_configuracion) {
  const cuenta = await cuentaDe(id_configuracion);
  return !!cuenta && Number(cuenta.activo) === 1;
}

/** ¿Está verificado en Zadarma el número de salida de la conexión? Se
 *  intenta fijar en una extensión de la central (y se limpia después). */
async function comprobarNumero(id_configuracion, numero) {
  const num = soloDigitos(numero);
  if (!num) {
    const e = new Error('Número vacío');
    e.status = 400;
    throw e;
  }
  const { numbers } = await extensionesCentral();
  const ext = numbers[0];
  if (!ext) throw new Error('La central de Zadarma no tiene extensiones');
  let verificado = 0;
  let detalle = 'Verificado en Zadarma';
  try {
    await api(`/v1/pbx/internal/${ext}/callerid/`, { number: num }, 'PUT');
    verificado = 1;
  } catch (e) {
    detalle = /confirmed|purchased/i.test(e.message)
      ? 'Este número no está verificado en Zadarma. Verifícalo en my.zadarma.com (Configuración → Conexión SIP → Identificador de llamada): al dueño del número le llega un código por llamada o SMS.'
      : e.message;
  }
  await api(`/v1/pbx/internal/${ext}/callerid/`, {}, 'DELETE').catch(() => {});
  await TelefoniaNumeros.upsert({ id_configuracion, numero: num, verificado, detalle, comprobado_at: new Date() });
  return { numero: num, verificado: verificado === 1, detalle };
}

/* ── Webhooks ──────────────────────────────────────────────────────────── */

/** Verifica la cabecera Signature según el evento (misma codificación que
 *  la firma de la API: hex del HMAC y luego base64). */
function firmaValida(body, firma) {
  if (!firma) return false;
  const ev = body.event;
  let base;
  if (ev === 'NOTIFY_OUT_START' || ev === 'NOTIFY_OUT_END') {
    base = `${body.internal || ''}${body.destination || ''}${body.call_start || ''}`;
  } else if (ev === 'NOTIFY_RECORD') {
    base = `${body.pbx_call_id || ''}${body.call_id_with_rec || ''}`;
  } else {
    base = `${body.caller_id || ''}${body.called_did || ''}${body.call_start || ''}`;
  }
  return hmacBase64(base) === firma;
}

/** Fila pendiente que corresponde a un webhook saliente (misma extensión y
 *  destino, la más reciente sin cerrar). */
async function llamadaDe(body) {
  if (body.pbx_call_id) {
    const porId = await TelefoniaLlamadas.findOne({ where: { pbx_call_id: body.pbx_call_id } });
    if (porId) return porId;
  }
  return TelefoniaLlamadas.findOne({
    where: {
      extension: String(body.internal || ''),
      telefono_cliente: soloDigitos(body.destination),
      fin_at: null,
    },
    order: [['id', 'DESC']],
  });
}

const fmtDuracion = (seg) => {
  const s = Number(seg) || 0;
  if (s < 60) return `${s} s`;
  return `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, '0')} s`;
};

/* Corre una fecha "YYYY-MM-DD HH:MM:SS" (hora de la cuenta Zadarma) unos
   minutos, sin tocar la zona: la API de estadísticas usa la misma hora. */
const correrMinutos = (texto, min) => {
  const d = new Date(`${String(texto).replace(' ', 'T')}Z`);
  if (Number.isNaN(d.getTime())) return null;
  return new Date(d.getTime() + min * 60000).toISOString().slice(0, 19).replace('T', ' ');
};

/**
 * Número con el que salió la llamada, según el registro de Zadarma.
 *
 * El caller ID que ponemos en la extensión es una intención: si el número de
 * la conexión no está confirmado, Zadarma usa el del SIP de la centralita y
 * el asesor no se entera. La única fuente que dice qué número se envió de
 * verdad es el campo `from` de /v1/statistics/ (el registro general de la
 * cuenta, no el de la centralita, que solo trae "Extension 100"). Se busca
 * la llamada por destino en una ventana de minutos alrededor del inicio.
 * Lo que la operadora del destino muestre después (a veces reemplaza el
 * número por uno de pasarela) no lo reporta nadie.
 */
/**
 * Trae la grabación a nuestro servidor y la borra de la nube de Zadarma.
 *
 * El plan Standard da 200 MB de nube y, según soporte (29-09-2026), al
 * llenarse SE DEJA DE GRABAR y el espacio solo se libera a mano, una por
 * una, pidiéndolo por chat. Por eso cada grabación se descarga apenas
 * Zadarma avisa (NOTIFY_RECORD), se guarda en uploads/telefonia/<cfg>/ y se
 * borra allá con DELETE /v1/pbx/record/request/. Así la nube queda siempre
 * casi vacía y el historial apunta a nuestra copia, sin el vencimiento de
 * 60 días de los enlaces de Zadarma.
 *
 * Si la descarga falla se deja el enlace de Zadarma (60 días) y NO se
 * borra: antes perder la copia de allá que quedarse sin nada.
 */
const DOMINIO_PUBLICO = () =>
  (process.env.PUBLIC_BASE_URL || 'https://chat.imporfactory.app').replace(/\/$/, '');

async function traerGrabacion(fila) {
  /* Zadarma identifica la grabación por call_id (llega en NOTIFY_RECORD o
     sale de las estadísticas) o por pbx_call_id (llega en NOTIFY_OUT_START).
     Si el aviso de grabación se perdió en un reinicio, el cron la pide con
     el que tenga. */
  const idGrabacion = fila.call_id_with_rec
    ? { call_id: fila.call_id_with_rec }
    : fila.pbx_call_id
      ? { pbx_call_id: fila.pbx_call_id }
      : null;
  if (!idGrabacion) return null;
  let enlace = null;
  try {
    const d = await api('/v1/pbx/record/request/', { ...idGrabacion, lifetime: 5184000 });
    enlace = d.link || (Array.isArray(d.links) ? d.links[0] : null);
  } catch (e) {
    console.warn('[telefonia] no se pudo pedir la grabación:', e.message);
    return null;
  }
  if (!enlace) return null;
  try {
    const r = await axios.get(enlace, { responseType: 'arraybuffer', timeout: 60000 });
    if (!r.data || r.data.length < 1000) throw new Error(`archivo vacío (${r.data?.length || 0} bytes)`);
    const audio = Buffer.from(r.data);
    const ext = /\.(wav|ogg|m4a)(\?|$)/i.exec(enlace)?.[1]?.toLowerCase() || 'mp3';
    const nombre = `${fila.id}.${ext}`;
    /* Primero S3 (el mismo uploader de las fotos del chat), para que la
       grabación no dependa del disco del servidor; si el uploader falla,
       queda en uploads/telefonia/<cfg>/ y se sirve desde aquí. */
    let url = null;
    try {
      const { uploadToUploader } = require('../utils/whatsappTemplate.helpers');
      const s3 = await uploadToUploader({
        buffer: audio,
        originalname: nombre,
        mimetype: ext === 'wav' ? 'audio/wav' : ext === 'ogg' ? 'audio/ogg' : 'audio/mpeg',
        folder: `telefonia/${fila.id_configuracion}`,
      });
      url = s3?.fileUrl || null;
    } catch (e) {
      console.warn('[telefonia] uploader S3 falló, guardo local:', e.message);
    }
    if (!url) {
      const dir = path.join(__dirname, '..', 'uploads', 'telefonia', String(fila.id_configuracion));
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, nombre), audio);
      url = `${DOMINIO_PUBLICO()}/uploads/telefonia/${fila.id_configuracion}/${nombre}`;
    }
    await fila.update({ grabada: 1, grabacion_url: url });
    await api('/v1/pbx/record/request/', idGrabacion, 'DELETE').catch((e) =>
      console.warn('[telefonia] grabación copiada pero no se pudo borrar en Zadarma:', e.message),
    );
    // Transcripción y resumen con IA, en segundo plano.
    setImmediate(() => {
      const ia = require('./telefonia_ia.service');
      ia.analizarLlamada(fila, { buffer: audio }).catch((e) =>
        console.error('[telefonia] análisis IA falló:', e.message),
      );
    });
    return url;
  } catch (e) {
    console.warn('[telefonia] no se pudo descargar la grabación, queda el enlace de Zadarma:', e.message);
    await fila.update({ grabada: 1, grabacion_url: enlace });
    return enlace;
  }
}

/** "YYYY-MM-DD HH:MM:SS" en hora de Ecuador, venga como texto de la base o
 *  como Date. Es la escala en la que Zadarma entrega sus estadísticas. */
const textoEc = (v) => {
  if (!v) return null;
  if (v instanceof Date) return new Date(v.getTime() - 5 * 3600_000).toISOString().slice(0, 19).replace('T', ' ');
  return String(v).slice(0, 19).replace('T', ' ');
};

/**
 * Registro de la llamada en /v1/statistics/ (el general de la cuenta): trae
 * el número con el que salió (`from`) y, sobre todo, lo que Zadarma COBRÓ
 * por ella (`billcost`). Se busca por destino en una ventana de minutos y
 * se toma la más cercana a la hora de inicio. Devuelve null si no aparece.
 */
async function registroGeneral(inicio, destino) {
  const ini = textoEc(inicio);
  const dest = soloDigitos(destino);
  if (!ini || !dest) return null;
  const d = await api('/v1/statistics/', { start: correrMinutos(ini, -2), end: correrMinutos(ini, 4) });
  const t0 = new Date(`${ini.replace(' ', 'T')}Z`).getTime();
  const hit = (Array.isArray(d.stats) ? d.stats : [])
    .filter((c) => String(c.to || '').endsWith(dest))
    .map((c) => ({ c, dist: Math.abs(new Date(`${String(c.callstart).replace(' ', 'T')}Z`).getTime() - t0) }))
    .sort((a, b) => a.dist - b.dist)[0];
  if (!hit) return null;
  return {
    from: hit.c.from ? soloDigitos(String(hit.c.from)) : null,
    billcost: Number.isFinite(Number(hit.c.billcost)) ? Number(hit.c.billcost) : null,
    billseconds: Number(hit.c.billseconds) || 0,
  };
}

/**
 * Margen de la conexión: cuánto cobra respecto a lo que cuesta. Sale de su
 * precio por minuto frente al costo de Zadarma a un celular de su país
 * (25 ¢ sobre 25 ¢ = 1, al costo; 40 ¢ sobre 25 ¢ = 1.6). Ese mismo factor
 * se aplica al costo real de cada llamada, vaya al país que vaya.
 * null si no se pudo consultar el costo de referencia.
 */
async function margenDe(cuenta, id_configuracion) {
  try {
    const [cfg] = await db.query(`SELECT pais FROM configuraciones WHERE id = ? LIMIT 1`, {
      replacements: [id_configuracion],
      type: db.QueryTypes.SELECT,
    });
    const ref = await costoReferencia(cfg?.pais || 'ec');
    if (!(ref.centavos_min > 0) || !(cuenta.tarifa_centavos_min > 0)) return null;
    return cuenta.tarifa_centavos_min / ref.centavos_min;
  } catch {
    return null;
  }
}

/**
 * Descuenta del saldo un monto EXACTO en centavos (con decimales) y devuelve
 * los centavos enteros que se cobraron. La fracción que sobra queda en
 * resto_centavos de la cuenta y se suma al siguiente cobro, de modo que lo
 * cobrado en total nunca se aleja más de 1 centavo del costo real: el saldo
 * de la conexión y el de Zadarma se mueven a la par. Va en una transacción
 * con la fila bloqueada: dos llamadas que cierran a la vez no se pisan.
 */
async function cobrarExacto({ id_configuracion, exacto_centavos, id_llamada, detalle, tipo = 'consumo' }) {
  return db.transaction(async (t) => {
    const cuenta = await TelefoniaCuentas.findByPk(id_configuracion, { transaction: t, lock: t.LOCK.UPDATE });
    // exacto puede ser negativo: un ajuste a favor de la conexión (se le
    // había cobrado de más con la tarifa fija y el costo real era menor).
    const total = (Number(exacto_centavos) || 0) + (Number(cuenta.resto_centavos) || 0);
    const cargo = Math.floor(total + 1e-9);
    const resto = Math.max(0, total - cargo);
    const saldo = Number(cuenta.saldo_centavos) - cargo;
    await cuenta.update({ saldo_centavos: saldo, resto_centavos: resto.toFixed(6), updated_at: new Date() }, { transaction: t });
    if (cargo !== 0) {
      await TelefoniaMovimientos.create(
        { id_configuracion, tipo, centavos: -cargo, saldo_despues_centavos: saldo, id_llamada, detalle },
        { transaction: t },
      );
    }
    return { cargo, saldo };
  });
}

/**
 * Ajusta al costo real una llamada que se cobró con la tarifa fija porque
 * Zadarma no entregó el costo al colgar (limita sus consultas de
 * estadísticas a unas pocas por minuto). Lo llama el cron de reconciliación
 * con el `billcost` ya leído. Cobra o devuelve solo la diferencia.
 */
async function ajustarACostoReal(fila, { costo_zadarma_usd, from = null, margen } = {}) {
  if (costo_zadarma_usd == null) return null;
  const cuenta = await cuentaDe(fila.id_configuracion, { crear: true });
  const factor = margen !== undefined ? margen : await margenDe(cuenta, fila.id_configuracion);
  if (factor == null) return null;
  // Se "reclama" la fila de forma atómica: solo un proceso hace el ajuste.
  const [n] = await TelefoniaLlamadas.update(
    { costo_zadarma_usd, ...(from && !fila.caller_id ? { caller_id: from } : {}) },
    { where: { id: fila.id, costo_zadarma_usd: null } },
  );
  if (n !== 1) return null;
  const yaCobrado = Number(fila.costo_centavos) || 0;
  const r = await cobrarExacto({
    id_configuracion: fila.id_configuracion,
    exacto_centavos: costo_zadarma_usd * 100 * factor - yaCobrado,
    id_llamada: fila.id,
    tipo: 'ajuste',
    detalle: `Ajuste al costo real · Zadarma $${Number(costo_zadarma_usd).toFixed(4)} (se había cobrado ${yaCobrado} ¢ por tarifa fija)`,
  });
  await TelefoniaLlamadas.update({ costo_centavos: Math.max(0, yaCobrado + r.cargo) }, { where: { id: fila.id } });
  return { ajuste_centavos: r.cargo, saldo_centavos: r.saldo };
}

const estadoDe = (disposition) => {
  const d = String(disposition || '').toLowerCase();
  if (d === 'answered') return 'answered';
  if (d === 'busy') return 'busy';
  if (d === 'cancel' || d === 'cancelled') return 'cancel';
  if (/no ?answer/.test(d)) return 'no_answer';
  return 'failed';
};

/** Cierres "sin evidencia" que hizo el cron (la llamada nunca se marcó, o
 *  pasó demasiado tiempo abierta): si después llega el dato real de Zadarma,
 *  se pueden volver a cerrar con él. Un cierre con datos reales es definitivo. */
const CIERRES_PROVISIONALES = ['no_marco', 'sin_cierre'];

/**
 * Cierra una llamada con los datos reales de Zadarma: estado, duración,
 * costo, descuento del saldo, aviso en el chat y evento al asesor.
 *
 * Es el ÚNICO camino de cierre, lo usan el webhook (NOTIFY_OUT_END) y el
 * cron de reconciliación (services/telefonia_reconciliar.service.js). El
 * UPDATE es atómico (solo cierra si sigue abierta o con cierre provisional):
 * si el webhook y el cron llegan a la vez, o corren dos servidores contra la
 * misma base, uno solo cobra. Devuelve null si otro ya la cerró.
 */
async function cerrarLlamada(
  fila,
  { duracion = 0, disposition = null, grabada = false, call_id_with_rec = null, pbx_call_id = null, caller_id = null, avisar = true, costo_zadarma_usd, margen } = {},
) {
  const estado = estadoDe(disposition);
  const cuenta = await cuentaDe(fila.id_configuracion, { crear: true });
  // 1. Se cierra primero (atómico) y recién después se cobra: solo quien
  //    gana el cierre llega a descontar saldo.
  const [cerradas] = await TelefoniaLlamadas.update(
    {
      pbx_call_id: pbx_call_id || fila.pbx_call_id,
      caller_id: caller_id || fila.caller_id,
      estado,
      disposition: disposition || null,
      duracion_seg: duracion,
      costo_centavos: 0,
      grabada: grabada ? 1 : 0,
      call_id_with_rec: call_id_with_rec || fila.call_id_with_rec,
      fin_at: new Date(),
    },
    { where: { id: fila.id, [Op.or]: [{ fin_at: null }, { disposition: { [Op.in]: CIERRES_PROVISIONALES } }] } },
  );
  if (cerradas !== 1) return null;
  await fila.reload();

  /* 2. Cuánto cobrar. Lo que Zadarma cobró de verdad por ESTA llamada, por
        el margen de la conexión. Antes era una tarifa única por minuto: una
        conexión "al costo" a 25 ¢ pagaba 25 ¢ también a México, donde
        Zadarma cobra 2 ¢, y su saldo se acababa antes que el de Zadarma
        (242, 2026-10-05: $1.63 de más en 12 llamadas). Si el costo real no
        se puede leer, respaldo: la tarifa fija por los segundos hablados. */
  let costo = 0;
  let saldo = Number(cuenta.saldo_centavos);
  let costoReal = null;
  if (estado === 'answered') {
    if (costo_zadarma_usd !== undefined) {
      costoReal = costo_zadarma_usd;
    } else {
      /* Un solo intento. Zadarma limita las consultas de estadísticas a
         unas pocas por minuto: si varios asesores cuelgan a la vez, alguna
         falla. En ese caso se cobra por la tarifa fija y la llamada queda
         con costo_zadarma_usd NULL; el cron la ajusta al costo real en su
         siguiente pasada (una sola consulta para todas). */
      const reg = await registroGeneral(fila.inicio_at, fila.telefono_cliente).catch(() => null);
      if (reg && reg.billseconds > 0) costoReal = reg.billcost;
      if (reg?.from && !caller_id) await fila.update({ caller_id: reg.from });
    }
    const factor = margen !== undefined ? margen : await margenDe(cuenta, fila.id_configuracion);
    const exacto =
      costoReal != null && factor != null
        ? costoReal * 100 * factor
        : (Math.max(0, duracion) * cuenta.tarifa_centavos_min) / 60;
    const r = await cobrarExacto({
      id_configuracion: fila.id_configuracion,
      exacto_centavos: exacto,
      id_llamada: fila.id,
      detalle: `${duracion} s a ${fila.telefono_cliente}${costoReal != null ? ` · Zadarma $${Number(costoReal).toFixed(4)}` : ' · tarifa fija'}`,
    });
    costo = r.cargo;
    saldo = r.saldo;
    await fila.update({ costo_centavos: costo, costo_zadarma_usd: costoReal });
  }
  // (No contestada: no se consulta nada aquí para no gastar el cupo de
  // estadísticas de Zadarma; el número con el que salió lo completa el cron.)
  if (avisar) {
    const cfg = await Configuraciones.findByPk(fila.id_configuracion);
    const cliente = fila.id_cliente_chat_center
      ? await ClientesChatCenter.findByPk(fila.id_cliente_chat_center)
      : null;
    const quien = await nombreSubUsuario(fila.id_sub_usuario);
    const texto =
      estado === 'answered'
        ? `📞 ${quien} llamó por teléfono · ${fmtDuracion(duracion)} · $${(costo / 100).toFixed(2)}`
        : estado === 'busy'
          ? `📵 ${quien} llamó por teléfono y estaba ocupado`
          : estado === 'no_answer'
            ? `📵 ${quien} llamó por teléfono y no contestaron`
            : `📵 ${quien} intentó llamar por teléfono (${disposition || 'sin conexión'})`;
    if (cfg) await notificarEnChat(cfg, cliente, texto);
    emitirA([fila.id_sub_usuario], 'TELEFONIA_ESTADO', {
      id: fila.id,
      estado,
      duracion_seg: duracion,
      costo_centavos: costo,
      saldo_centavos: saldo,
      telefono: fila.telefono_cliente,
      id_cliente_chat_center: fila.id_cliente_chat_center,
    });
  }
  return { estado, costo_centavos: costo, saldo_centavos: saldo };
}

async function manejarWebhook(body) {
  const ev = body.event;
  if (ev === 'NOTIFY_OUT_START') {
    const fila = await llamadaDe(body);
    if (!fila) return;
    await fila.update({ pbx_call_id: body.pbx_call_id || fila.pbx_call_id, estado: 'ringing' });
    emitirA([fila.id_sub_usuario], 'TELEFONIA_ESTADO', {
      id: fila.id,
      estado: 'ringing',
      telefono: fila.telefono_cliente,
      id_cliente_chat_center: fila.id_cliente_chat_center,
    });
    return;
  }
  if (ev === 'NOTIFY_OUT_END') {
    const fila = await llamadaDe(body);
    if (!fila) return;
    // El número con el que salió y el costo real los lee cerrarLlamada del
    // registro general de Zadarma (una sola consulta para las dos cosas).
    await cerrarLlamada(fila, {
      duracion: Number(body.duration || 0),
      disposition: body.disposition || null,
      grabada: Number(body.is_recorded) === 1,
      call_id_with_rec: body.call_id_with_rec || null,
      pbx_call_id: body.pbx_call_id || null,
      caller_id: body.caller_id && soloDigitos(body.caller_id) ? soloDigitos(body.caller_id) : null,
    });
    return;
  }
  if (ev === 'NOTIFY_RECORD') {
    const fila = body.pbx_call_id
      ? await TelefoniaLlamadas.findOne({ where: { pbx_call_id: body.pbx_call_id } })
      : null;
    if (!fila) return;
    await fila.update({ grabada: 1, call_id_with_rec: body.call_id_with_rec });
    await traerGrabacion(fila);
    return;
  }
  // NOTIFY_START / NOTIFY_END / NOTIFY_ANSWER / NOTIFY_INTERNAL: llamadas
  // entrantes a números de Zadarma; por ahora solo se registran en el log.
  console.log('[telefonia] webhook', ev, body.pbx_call_id || '');
}

/* ── Configuración desde nuestro backend ───────────────────────────────── */

/** Registra la URL de webhooks en Zadarma (valida con zd_echo) y enciende la
 *  grabación de todas las extensiones. Se corre una vez desde /diagnostico. */
async function configurarCuenta(urlWebhook, emailGrabaciones = null) {
  const salida = {};
  try {
    salida.webhook = await api('/v1/pbx/callinfo/url/', { url: urlWebhook }, 'POST');
  } catch (e) {
    if (/wrong parameters/i.test(e.message)) {
      const err = new Error(
        `Zadarma no pudo validar la URL ${urlWebhook}: antes de guardarla la llama con ?zd_echo=… y espera la misma respuesta. Esa dirección debe ser pública y tener este código desplegado (el backend local no sirve).`,
      );
      err.status = 400;
      throw err;
    }
    throw e;
  }
  // La grabación se enciende por extensión (Zadarma exige el id de la
  // extensión y un correo al que avisar; sin ellos responde "Wrong PBX
  // number" / 'check "Email" field').
  const { numbers } = await extensionesCentral();
  const grabacion = { encendidas: [], errores: [] };
  for (const ext of numbers) {
    try {
      await api('/v1/pbx/internal/recording/', { id: ext, status: 'on', email: emailGrabaciones || undefined }, 'PUT');
      grabacion.encendidas.push(ext);
    } catch (e) {
      grabacion.errores.push(`${ext}: ${e.message}`);
    }
  }
  salida.grabacion = grabacion;
  try {
    const fila = await TelefoniaMaestra.findByPk(1);
    if (fila) await fila.update({ webhook_url: urlWebhook, webhook_instalado_at: new Date() });
  } catch (e) {
    console.warn('[telefonia] no se guardó la URL del webhook:', e.message);
  }
  return salida;
}

async function diagnostico() {
  const out = { configurado: configurado() };
  if (!out.configurado) return out;
  out.balance = await balance().catch((e) => ({ error: e.message }));
  // Plan de llamadas (Standard = por segundo, Economy = por minuto) y si
  // está activo: Zadarma lo activa con la primera recarga.
  out.plan = await api('/v1/tariff/')
    .then((d) => ({ nombre: d.info?.tariff_name, activo: String(d.info?.is_active) === 'true', costo_mensual: Number(d.info?.cost || 0) }))
    .catch((e) => ({ error: e.message }));
  out.sip_principal = await sipPrincipal().catch((e) => ({ error: e.message }));
  out.central = await extensionesCentral().catch((e) => ({ error: e.message }));
  out.extensiones_asignadas = await TelefoniaExtensiones.findAll({
    attributes: ['id_sub_usuario', 'extension', 'sip_login', 'widget_key_vence_at'],
  });
  return out;
}

module.exports = {
  configurado,
  cargarCredenciales,
  guardarCredenciales,
  estadoCredenciales,
  firmar,
  construirQuery,
  api,
  balance,
  llaveWidget,
  asegurarExtension,
  cuentaDe,
  costoReferencia,
  cuentaTieneTelefonia,
  conexionTieneTelefonia,
  recargar,
  retirar,
  llamar,
  comprobarNumero,
  firmaValida,
  manejarWebhook,
  cerrarLlamada,
  ajustarACostoReal,
  registroGeneral,
  margenDe,
  costoDestino,
  CIERRES_PROVISIONALES,
  traerGrabacion,
  configurarCuenta,
  diagnostico,
  costoCentavos,
};
