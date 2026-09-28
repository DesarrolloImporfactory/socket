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
const { db } = require('../database/config');
const ClientesChatCenter = require('../models/clientes_chat_center.model');
const Configuraciones = require('../models/configuraciones.model');
const TelefoniaLlamadas = require('../models/telefonia_llamadas.model');
const TelefoniaExtensiones = require('../models/telefonia_extensiones.model');
const TelefoniaCuentas = require('../models/telefonia_cuentas.model');
const TelefoniaMovimientos = require('../models/telefonia_movimientos.model');
const TelefoniaMaestra = require('../models/telefonia_maestra.model');
const { encryptToken, decryptToken, last4 } = require('../utils/cryptoToken');
const { emitirA, notificarEnChat } = require('./llamadas_whatsapp.service');

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
  const esGet = httpMethod === 'GET' || httpMethod === 'DELETE';
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
async function asegurarExtension(id_sub_usuario) {
  const actual = await TelefoniaExtensiones.findOne({ where: { id_sub_usuario } });
  if (actual) return actual;
  const [{ numbers }, sip] = await Promise.all([extensionesCentral(), sipPrincipal()]);
  const usadas = new Set(
    (await TelefoniaExtensiones.findAll({ attributes: ['extension'] })).map((e) => e.extension),
  );
  const libre = numbers.find((n) => !usadas.has(n));
  if (!libre) {
    const e = new Error(
      'No quedan extensiones libres en la central de Zadarma. Crea más en Mi PBX → Extensiones.',
    );
    e.status = 409;
    throw e;
  }
  return TelefoniaExtensiones.create({
    id_sub_usuario,
    extension: libre,
    sip_login: `${sip}-${libre}`,
  });
}

/** Llave del widget WebRTC del asesor (Zadarma la da por 72 h; se renueva
 *  con margen de 12 h). */
async function llaveWidget(id_sub_usuario) {
  const ext = await asegurarExtension(id_sub_usuario);
  const vigente =
    ext.widget_key && ext.widget_key_vence_at && new Date(ext.widget_key_vence_at) > new Date();
  if (!vigente) {
    const d = await api('/v1/webrtc/get_key/', { sip: ext.sip_login }, 'GET');
    const key = d.key || d.data?.key;
    if (!key) throw new Error('Zadarma no devolvió la llave del widget');
    await ext.update({
      widget_key: key,
      widget_key_vence_at: new Date(Date.now() + 60 * 3600 * 1000),
    });
  }
  return { key: ext.widget_key, sip: ext.sip_login, extension: ext.extension };
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

/** Centavos que cuesta una llamada de N segundos a la tarifa de la cuenta
 *  (cobro por segundo, redondeado hacia arriba al centavo). */
const costoCentavos = (segundos, tarifaMin) => Math.ceil((Math.max(0, segundos) * tarifaMin) / 60);

/* ── Llamar ────────────────────────────────────────────────────────────── */

const soloDigitos = (t) => String(t || '').replace(/\D/g, '');

async function llamar({ id_configuracion, id_cliente, id_sub_usuario }) {
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
  // Mínimo un minuto de saldo para arrancar; el consumo real va por segundo.
  if (Number(cuenta.saldo_centavos) < Number(cuenta.tarifa_centavos_min)) {
    const e = new Error('Saldo insuficiente para llamar. Recarga para continuar.');
    e.status = 402;
    e.code = 'SIN_SALDO';
    throw e;
  }
  const ext = await asegurarExtension(id_sub_usuario);

  // El cliente debe ver el número de la tienda, no uno desconocido.
  if (cuenta.caller_id) {
    try {
      await api(`/v1/pbx/internal/${ext.extension}/callerid/`, { number: soloDigitos(cuenta.caller_id) }, 'PUT');
    } catch (e) {
      console.warn('[telefonia] no se pudo fijar el CallerID:', e.message);
    }
  }

  const fila = await TelefoniaLlamadas.create({
    id_configuracion,
    id_cliente_chat_center: cliente.id,
    id_sub_usuario,
    extension: ext.extension,
    telefono_cliente: destino,
    caller_id: cuenta.caller_id || null,
    estado: 'pedida',
    inicio_at: new Date(),
  });

  try {
    await api('/v1/request/callback/', { from: ext.extension, to: destino });
  } catch (e) {
    await fila.update({ estado: 'failed', disposition: e.message, fin_at: new Date() });
    throw e;
  }
  emitirA([id_sub_usuario], 'TELEFONIA_ESTADO', {
    id: fila.id,
    estado: 'pedida',
    telefono: destino,
    id_cliente_chat_center: cliente.id,
  });
  return {
    id: fila.id,
    extension: ext.extension,
    telefono: destino,
    saldo_centavos: cuenta.saldo_centavos,
    tarifa_centavos_min: cuenta.tarifa_centavos_min,
  };
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
    const duracion = Number(body.duration || 0);
    const disposition = String(body.disposition || '').toLowerCase();
    const estado =
      disposition === 'answered'
        ? 'answered'
        : disposition === 'busy'
          ? 'busy'
          : disposition === 'cancel' || disposition === 'cancelled'
            ? 'cancel'
            : /no ?answer/.test(disposition)
              ? 'no_answer'
              : 'failed';
    const cuenta = await cuentaDe(fila.id_configuracion, { crear: true });
    const costo = estado === 'answered' ? costoCentavos(duracion, cuenta.tarifa_centavos_min) : 0;
    await fila.update({
      pbx_call_id: body.pbx_call_id || fila.pbx_call_id,
      estado,
      disposition: body.disposition || null,
      duracion_seg: duracion,
      costo_centavos: costo,
      grabada: Number(body.is_recorded) === 1 ? 1 : 0,
      call_id_with_rec: body.call_id_with_rec || fila.call_id_with_rec,
      fin_at: new Date(),
    });
    if (costo > 0) {
      await movimiento({
        id_configuracion: fila.id_configuracion,
        tipo: 'consumo',
        centavos: -costo,
        id_llamada: fila.id,
        detalle: `${duracion} s a ${fila.telefono_cliente}`,
      });
    }
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
            : `📵 ${quien} intentó llamar por teléfono (${body.disposition || 'sin conexión'})`;
    if (cfg) await notificarEnChat(cfg, cliente, texto);
    emitirA([fila.id_sub_usuario], 'TELEFONIA_ESTADO', {
      id: fila.id,
      estado,
      duracion_seg: duracion,
      costo_centavos: costo,
      saldo_centavos: (await cuentaDe(fila.id_configuracion, { crear: true })).saldo_centavos,
      telefono: fila.telefono_cliente,
      id_cliente_chat_center: fila.id_cliente_chat_center,
    });
    return;
  }
  if (ev === 'NOTIFY_RECORD') {
    const fila = body.pbx_call_id
      ? await TelefoniaLlamadas.findOne({ where: { pbx_call_id: body.pbx_call_id } })
      : null;
    if (!fila) return;
    let url = null;
    try {
      const d = await api('/v1/pbx/record/request/', {
        call_id: body.call_id_with_rec,
        lifetime: 5184000, // 60 días, el máximo que permite Zadarma
      });
      url = d.link || (Array.isArray(d.links) ? d.links[0] : null);
    } catch (e) {
      console.warn('[telefonia] no se pudo pedir la grabación:', e.message);
    }
    await fila.update({ grabada: 1, call_id_with_rec: body.call_id_with_rec, grabacion_url: url });
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
  cuentaTieneTelefonia,
  recargar,
  llamar,
  firmaValida,
  manejarWebhook,
  configurarCuenta,
  diagnostico,
  costoCentavos,
};
