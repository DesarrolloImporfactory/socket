/**
 * Transcripción y resumen con IA de las llamadas telefónicas (Zadarma).
 *
 * Flujo (lo dispara zadarma.service.traerGrabacion apenas la grabación llega
 * a nuestro servidor):
 *   1. audio → texto con gpt-4o-mini-transcribe ($0.003/min de audio).
 *   2. texto → resumen + datos estructurados con gpt-5-mini (JSON).
 *   3. Se guarda en telefonia_analisis y se deja el resumen como notificación
 *      en el chat del cliente, para que el asesor y el administrador lo vean
 *      sin salir de la conversación.
 *
 * Llave: la maestra de /telefonia (telefonia_ia) y, si no hay, la
 * api_key_openai de la conexión (leída con leerApiKeyOpenAI, nunca cruda).
 * Sin ninguna de las dos, la llamada queda en 'sin_llave' y se reintenta la
 * próxima vez que alguien guarde una llave (reanalizarPendientes).
 *
 * Costos de referencia (2026-09): transcripción $0.003/min; gpt-5-mini
 * $0.25 por millón de tokens de entrada y $2 por millón de salida. Una
 * llamada de 5 min cuesta alrededor de 2 centavos en total.
 */
const axios = require('axios');
const FormData = require('form-data');
const { db } = require('../database/config');
const TelefoniaIA = require('../models/telefonia_ia.model');
const TelefoniaAnalisis = require('../models/telefonia_analisis.model');
const TelefoniaLlamadas = require('../models/telefonia_llamadas.model');
const Configuraciones = require('../models/configuraciones.model');
const ClientesChatCenter = require('../models/clientes_chat_center.model');
const { encryptToken, decryptToken, last4 } = require('../utils/cryptoToken');
const { leerApiKeyOpenAI } = require('../utils/openia/apiKeyOpenAI');
const { emitirA, notificarEnChat } = require('./llamadas_whatsapp.service');

const log = (...a) => console.log('[telefonia-ia]', ...a);

/* ── Llave ─────────────────────────────────────────────────────────────── */

async function filaMaestra() {
  try {
    return await TelefoniaIA.findByPk(1);
  } catch (e) {
    if (/doesn't exist/i.test(e?.message || '')) return null;
    throw e;
  }
}

/** { key, origen, modelos } o null si no hay con qué analizar. */
async function llaveParaConexion(id_configuracion) {
  const m = await filaMaestra();
  const modelos = {
    transcripcion: m?.modelo_transcripcion || 'gpt-4o-mini-transcribe',
    resumen: m?.modelo_resumen || 'gpt-5-mini',
  };
  if (m && Number(m.activo) === 1 && m.api_key_enc) {
    try {
      const key = decryptToken(m.api_key_enc).trim();
      if (key) return { key, origen: 'maestra', modelos };
    } catch (e) {
      console.error('[telefonia-ia] no se pudo descifrar la llave maestra:', e.message);
    }
  }
  const cfg = await Configuraciones.findByPk(id_configuracion, { attributes: ['id', 'api_key_openai'] });
  const key = leerApiKeyOpenAI(cfg?.api_key_openai);
  return key ? { key, origen: 'conexion', modelos } : null;
}

async function estadoLlave() {
  const m = await filaMaestra();
  const [pend] = await db.query(
    `SELECT SUM(estado = 'sin_llave') AS sin_llave, SUM(estado = 'error') AS con_error,
            SUM(estado = 'listo') AS listas, SUM(costo_centavos) AS costo_centavos
     FROM telefonia_analisis`,
    { type: db.QueryTypes.SELECT },
  ).catch(() => [{}]);
  return {
    configurada: !!m?.api_key_enc,
    activo: m ? Number(m.activo) === 1 : false,
    api_key_last4: m?.api_key_last4 || null,
    modelo_transcripcion: m?.modelo_transcripcion || 'gpt-4o-mini-transcribe',
    modelo_resumen: m?.modelo_resumen || 'gpt-5-mini',
    updated_at: m?.updated_at || null,
    analisis: {
      listas: Number(pend?.listas || 0),
      sin_llave: Number(pend?.sin_llave || 0),
      con_error: Number(pend?.con_error || 0),
      costo_centavos: Number(pend?.costo_centavos || 0),
    },
  };
}

/** Prueba la llave contra OpenAI antes de guardarla (lista de modelos). */
async function guardarLlave({ api_key, activo = true, id_sub_usuario = null }) {
  const key = String(api_key || '').trim();
  if (!/^sk-/.test(key)) {
    const e = new Error('La llave de OpenAI debe empezar con "sk-"');
    e.status = 400;
    throw e;
  }
  const r = await axios.get('https://api.openai.com/v1/models/gpt-5-mini', {
    headers: { Authorization: `Bearer ${key}` },
    timeout: 15000,
    validateStatus: () => true,
  });
  if (r.status === 401) {
    const e = new Error('OpenAI rechazó la llave (401). Revisa que esté completa y vigente.');
    e.status = 400;
    throw e;
  }
  if (r.status >= 400) {
    const e = new Error(`OpenAI respondió ${r.status}: ${r.data?.error?.message || 'sin detalle'}`);
    e.status = 400;
    throw e;
  }
  await TelefoniaIA.upsert({
    id: 1,
    api_key_enc: encryptToken(key),
    api_key_last4: last4(key),
    activo: activo ? 1 : 0,
    actualizado_por: id_sub_usuario,
    updated_at: new Date(),
  });
  setImmediate(() => reanalizarPendientes().catch((e) => log('reanálisis falló:', e.message)));
  return estadoLlave();
}

async function apagarLlave(activo) {
  const m = await filaMaestra();
  if (m) await m.update({ activo: activo ? 1 : 0, updated_at: new Date() });
  return estadoLlave();
}

/* ── OpenAI ────────────────────────────────────────────────────────────── */

async function transcribir({ key, modelo, buffer, nombre }) {
  const form = new FormData();
  form.append('file', buffer, { filename: nombre || 'llamada.mp3', contentType: 'audio/mpeg' });
  form.append('model', modelo);
  form.append('language', 'es');
  form.append('response_format', 'json');
  const r = await axios.post('https://api.openai.com/v1/audio/transcriptions', form, {
    headers: { ...form.getHeaders(), Authorization: `Bearer ${key}` },
    timeout: 180000,
    maxBodyLength: Infinity,
  });
  return String(r.data?.text || '').trim();
}

const PROMPT_RESUMEN = `Eres el supervisor de un equipo de ventas y atención al cliente que trabaja por WhatsApp y teléfono. Te paso la transcripción de una llamada que un asesor hizo a un cliente. Responde SOLO con un JSON con estas claves:
- "resumen": 3 a 5 líneas en español, en pasado, qué se habló y en qué quedó. Sin saludos ni relleno.
- "resultado": uno de "venta_cerrada", "interesado", "sin_interes", "no_contesto", "reagendar", "reclamo", "otro".
- "motivo": una frase con el motivo principal de la llamada.
- "objeciones": lista de objeciones o dudas del cliente (puede ir vacía).
- "compromisos": lista de lo que el asesor o el cliente se comprometió a hacer (puede ir vacía).
- "siguiente_paso": una frase con la acción concreta que debería seguir (o "ninguno").
- "sentimiento": "positivo", "neutral" o "negativo" (del cliente).
- "calidad_atencion": entero 1 a 5 de cómo atendió el asesor (claridad, cortesía, resolver).
- "mejoras": lista de 1 a 3 sugerencias cortas y concretas para que el asesor lo haga mejor la próxima vez.
Si la transcripción es un buzón de voz, música o no hay conversación real, usa resultado "no_contesto", resumen "No hubo conversación." y listas vacías.`;

async function resumir({ key, modelo, transcripcion, contexto }) {
  const body = {
    model: modelo,
    instructions: PROMPT_RESUMEN,
    // OpenAI exige la palabra "JSON" en el input (no basta en instructions)
    // para aceptar text.format json_object.
    input: `${contexto}\nResponde en JSON con el formato indicado.\n\nTRANSCRIPCIÓN:\n${transcripcion.slice(0, 60000)}`,
    text: { format: { type: 'json_object' } },
    max_output_tokens: 1200,
  };
  if (/^gpt-5/i.test(modelo)) body.reasoning = { effort: 'low' };
  const r = await axios.post('https://api.openai.com/v1/responses', body, {
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    timeout: 120000,
  });
  const msg = (r.data?.output || []).find((i) => i.type === 'message');
  const texto = msg?.content?.find((c) => c.type === 'output_text')?.text || '';
  let json = null;
  try {
    json = JSON.parse(texto);
  } catch {
    const m = texto.match(/\{[\s\S]*\}/);
    if (m) {
      try {
        json = JSON.parse(m[0]);
      } catch {
        json = null;
      }
    }
  }
  return { json, usage: r.data?.usage || {} };
}

const PRECIOS = {
  transcripcion_centavos_min: 0.3, // gpt-4o-mini-transcribe
  entrada_por_millon: 25, // gpt-5-mini, centavos
  salida_por_millon: 200,
};

/* ── Análisis de una llamada ───────────────────────────────────────────── */

const ETIQUETA_RESULTADO = {
  venta_cerrada: '✅ Venta cerrada',
  interesado: '🟢 Interesado',
  sin_interes: '🔴 Sin interés',
  no_contesto: '📵 No hubo conversación',
  reagendar: '📅 Reagendar',
  reclamo: '⚠️ Reclamo',
  otro: 'ℹ️ Otro',
};

/**
 * Analiza una llamada ya grabada. `buffer` es el audio (si no viene, se
 * descarga de grabacion_url). Idempotente: si ya está 'listo' no repite.
 */
async function analizarLlamada(fila, { buffer = null } = {}) {
  const id_llamada = fila.id;
  let an = await TelefoniaAnalisis.findByPk(id_llamada);
  if (an && an.estado === 'listo') return an;
  if (!an) an = await TelefoniaAnalisis.create({ id_llamada, id_configuracion: fila.id_configuracion });

  const llave = await llaveParaConexion(fila.id_configuracion);
  if (!llave) {
    await an.update({ estado: 'sin_llave', updated_at: new Date() });
    return an;
  }
  try {
    let audio = buffer;
    if (!audio) {
      if (!fila.grabacion_url) throw new Error('la llamada no tiene grabación');
      const r = await axios.get(fila.grabacion_url, { responseType: 'arraybuffer', timeout: 60000 });
      audio = Buffer.from(r.data);
    }
    const transcripcion = await transcribir({
      key: llave.key,
      modelo: llave.modelos.transcripcion,
      buffer: audio,
      nombre: `llamada-${id_llamada}.mp3`,
    });
    const cliente = fila.id_cliente_chat_center ? await ClientesChatCenter.findByPk(fila.id_cliente_chat_center) : null;
    const [su] = await db.query(
      `SELECT nombre_encargado FROM sub_usuarios_chat_center WHERE id_sub_usuario = ? LIMIT 1`,
      { replacements: [fila.id_sub_usuario], type: db.QueryTypes.SELECT },
    );
    const contexto = `Asesor: ${su?.nombre_encargado || 'desconocido'}. Cliente: ${cliente?.nombre_cliente || 'desconocido'}. Duración: ${fila.duracion_seg || 0} segundos.`;
    let json = null;
    let usage = {};
    if (transcripcion.length >= 20) {
      ({ json, usage } = await resumir({
        key: llave.key,
        modelo: llave.modelos.resumen,
        transcripcion,
        contexto,
      }));
    } else {
      json = { resumen: 'No hubo conversación.', resultado: 'no_contesto', objeciones: [], compromisos: [], mejoras: [] };
    }
    const minutos = Math.max(1, Math.ceil((Number(fila.duracion_seg) || 0) / 60));
    const costo = Math.ceil(
      minutos * PRECIOS.transcripcion_centavos_min +
        ((usage.input_tokens || 0) * PRECIOS.entrada_por_millon) / 1e6 +
        ((usage.output_tokens || 0) * PRECIOS.salida_por_millon) / 1e6,
    );
    await an.update({
      estado: 'listo',
      transcripcion,
      resumen: json?.resumen || null,
      analisis: json ? JSON.stringify(json) : null,
      modelo_transcripcion: llave.modelos.transcripcion,
      modelo_resumen: llave.modelos.resumen,
      tokens_entrada: usage.input_tokens || null,
      tokens_salida: usage.output_tokens || null,
      costo_centavos: costo,
      origen_llave: llave.origen,
      error: null,
      updated_at: new Date(),
    });
    log(`llamada ${id_llamada} analizada (${transcripcion.length} caracteres, ${costo} ¢)`);

    // Resumen al chat, debajo del aviso de la llamada, y al asesor por socket.
    const cfg = await Configuraciones.findByPk(fila.id_configuracion);
    if (cfg && cliente && json?.resumen) {
      const partes = [`📝 Resumen de la llamada · ${ETIQUETA_RESULTADO[json.resultado] || ETIQUETA_RESULTADO.otro}`, json.resumen];
      if (json.siguiente_paso && !/^ninguno/i.test(json.siguiente_paso)) partes.push(`➡️ Siguiente paso: ${json.siguiente_paso}`);
      await notificarEnChat(cfg, cliente, partes.join('\n'));
    }
    emitirA([fila.id_sub_usuario], 'TELEFONIA_ANALISIS', {
      id: id_llamada,
      id_cliente_chat_center: fila.id_cliente_chat_center,
      resumen: json?.resumen || null,
      resultado: json?.resultado || null,
    });
    return an;
  } catch (e) {
    const detalle = e?.response?.data?.error?.message || e.message;
    console.error(`[telefonia-ia] llamada ${id_llamada}:`, detalle);
    await an.update({ estado: 'error', error: String(detalle).slice(0, 500), updated_at: new Date() });
    return an;
  }
}

/** Reintenta las que quedaron sin llave o con error (al guardar una llave,
 *  o a mano). Máximo `limite` por corrida para no reventar el rate limit. */
async function reanalizarPendientes(limite = 50) {
  const pend = await TelefoniaAnalisis.findAll({
    where: db.literal("estado IN ('sin_llave','error','pendiente')"),
    order: [['id_llamada', 'DESC']],
    limit: limite,
  });
  let ok = 0;
  for (const an of pend) {
    const fila = await TelefoniaLlamadas.findByPk(an.id_llamada);
    if (!fila || !fila.grabacion_url) continue;
    const r = await analizarLlamada(fila);
    if (r.estado === 'listo') ok += 1;
  }
  return { intentadas: pend.length, listas: ok };
}

module.exports = {
  estadoLlave,
  guardarLlave,
  apagarLlave,
  analizarLlamada,
  reanalizarPendientes,
  ETIQUETA_RESULTADO,
};
