'use strict';

/**
 * Respondedor logístico SIN IA para las columnas del flujo Dropi.
 *
 * ── Por qué existe ─────────────────────────────────────────────────────────
 * Cuando el chat vive en una columna logística (guía generada, en tránsito,
 * retiro en agencia, novedad, entregada…) esas columnas no tienen agente de
 * IA y las preguntas del cliente quedaban al aire: "¿cuál es mi guía?",
 * "¿dónde retiro?", "¿cuánto demora?". Ponerles un asistente a todas sería
 * tokens en cada mensaje de cada tienda para 3 preguntas repetidas — y una
 * IA puede INVENTAR la fecha de entrega, que es el reclamo que no queremos.
 *
 * ── Qué hace ───────────────────────────────────────────────────────────────
 * Un matcher conservador de 3 intenciones que responde con DATOS REALES de
 * la última orden del cliente (dropi_orders_cache), 0 tokens:
 *   guia   → número de guía + transportadora + link de tracking.
 *   retiro → la agencia real (utils/lugarRetiroAgencia, con sus fallbacks).
 *   demora → rango honesto de días calculado del HISTORIAL de entregas de la
 *            misma tienda a la misma ciudad (delivered_at); si aún no hay
 *            datos suficientes, un rango genérico + link de tracking. Nunca
 *            promete una fecha.
 * Todo lo demás → silencio, para el humano (mismo criterio del wizard).
 *
 * ── Radio de impacto ───────────────────────────────────────────────────────
 * Solo responde si TODO se cumple: la columna actual es un destino del
 * notifier Dropi (dropi_plantillas_config) — o sea cuentas e-commerce con
 * ese flujo —, la columna NO tiene IA activa, la pregunta calza con una
 * intención y el teléfono tiene una orden en el cache.
 *
 * ── Ajustes por cuenta ─────────────────────────────────────────────────────
 * respondedor_logistico_config (pantalla "Plantillas de seguimiento" del
 * kanban) permite: apagar el respondedor completo (activo=0) o fijar un rango
 * manual de días para "demora" (demora_dias_min/max) que pisa el histórico.
 * Sin fila: encendido y automático — el default vive acá, no en la BD.
 */

const { db } = require('../database/config');
const {
  getTrackingUrl,
  normalizePhone,
} = require('../services/dropi_notifier.service');
const { resolverLugarRetiro } = require('./lugarRetiroAgencia');
const {
  enviarMensajeWhatsapp,
} = require('./webhook_whatsapp/enviarMensajes');

// Mismo responsable que las respuestas rápidas del wizard: el chat ya lo
// muestra como respuesta sin IA.
const RESPONSABLE = 'IA_respuesta_rapida';

// Timeout corto para el scraping de Servientrega: esto corre en el flujo del
// webhook; si no responde a tiempo, resolverLugarRetiro cae a su fallback.
const TIMEOUT_AGENCIA_MS = 8000;

/* ═══════════════════════════════════════════════════════════
   0. Ajustes por cuenta (respondedor_logistico_config)
   ═══════════════════════════════════════════════════════════ */

// Sin fila en la tabla, todo sigue como siempre: encendido y rango automático.
const CONFIG_DEFAULT = Object.freeze({
  activo: 1,
  demora_dias_min: null,
  demora_dias_max: null,
});

// Esto corre por CADA mensaje entrante en columnas logísticas: un cache corto
// evita repetir la consulta en ráfagas. Se invalida al guardar desde la
// pantalla (mismo proceso); entre procesos el TTL lo resuelve solo.
const CONFIG_TTL_MS = 60 * 1000;
const configCache = new Map(); // id_configuracion -> { at, cfg }

async function getConfigRespondedor(id_configuracion) {
  const key = Number(id_configuracion);
  const hit = configCache.get(key);
  if (hit && Date.now() - hit.at < CONFIG_TTL_MS) return hit.cfg;

  let cfg = CONFIG_DEFAULT;
  try {
    const [row] = await db.query(
      `SELECT activo, demora_dias_min, demora_dias_max
         FROM respondedor_logistico_config
        WHERE id_configuracion = ? LIMIT 1`,
      { replacements: [key], type: db.QueryTypes.SELECT },
    );
    if (row) {
      cfg = {
        activo: Number(row.activo) === 0 ? 0 : 1,
        demora_dias_min: row.demora_dias_min ?? null,
        demora_dias_max: row.demora_dias_max ?? null,
      };
    }
  } catch (_) {
    // Tabla aún no creada (db.sync pendiente): defaults, nunca romper el flujo.
  }
  configCache.set(key, { at: Date.now(), cfg });
  return cfg;
}

function invalidarConfigRespondedor(id_configuracion) {
  configCache.delete(Number(id_configuracion));
}

/* Rango manual válido: ambos enteros ≥1 y max ≥ min. Cualquier otra cosa se
   ignora y se cae al cálculo automático. */
function rangoManual(cfg) {
  const min = Number(cfg?.demora_dias_min);
  const max = Number(cfg?.demora_dias_max);
  if (!Number.isInteger(min) || !Number.isInteger(max)) return null;
  if (min < 1 || max < min) return null;
  return { desde: min, hasta: max };
}

/* ═══════════════════════════════════════════════════════════
   1. Intención
   ═══════════════════════════════════════════════════════════ */

const sinTildes = (t) =>
  String(t || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');

const RE_RETIRO =
  /(donde|dnde|en que|cual).{0,25}(retir|recoj|recog|agencia)|agencia.{0,25}(queda|retir|recoj|recog|direccion|esta)|punto de retiro|que agencia|direccion.{0,20}agencia/;
const RE_GUIA =
  /(numero|nro|n[°o]|codigo|cual es).{0,15}(guia|rastreo|seguimiento|tracking)|mi guia\b|la guia\b|\btracking\b|rastrear|rastreo|link de seguimiento|hacer seguimiento/;
const RE_DEMORA =
  /cuant[oa]s? (dias?|tiempo).{0,20}(demora|tarda|llega|entrega)|cuant[oa] (demora|tarda|se demora|se tarda)|cuando (llega|me llega|estaria|estara|arriba|viene)|que dia (llega|me llega)|(tiempo|dias?) de entrega|demora la entrega|fecha de entrega|(aun|todavia) no (llega|me llega)|no me ha llegado|ya viene en camino|en cuanto(s dias)? llega/;

function detectarIntencion(texto_mensaje) {
  const t = sinTildes(texto_mensaje).trim();
  // Mensajes largos suelen traer más de una cosa (reclamos, direcciones
  // nuevas): eso es para un humano, no para una respuesta automática.
  if (!t || t.length > 200) return null;
  if (RE_RETIRO.test(t)) return 'retiro';
  if (RE_GUIA.test(t)) return 'guia';
  if (RE_DEMORA.test(t)) return 'demora';
  return null;
}

/* ═══════════════════════════════════════════════════════════
   2. Gate: columna logística sin IA
   ═══════════════════════════════════════════════════════════ */

async function esColumnaLogisticaSinIA(id_configuracion, estado_contacto) {
  const estado = String(estado_contacto || '').trim();
  if (!estado) return false;

  const destinos = await db.query(
    `SELECT DISTINCT columna_destino FROM dropi_plantillas_config
      WHERE id_configuracion = ? AND activo = 1
        AND columna_destino IS NOT NULL AND columna_destino != ''`,
    { replacements: [id_configuracion], type: db.QueryTypes.SELECT },
  );
  const set = new Set(destinos.map((d) => String(d.columna_destino).toLowerCase()));
  if (!set.has(estado.toLowerCase())) return false;

  const [col] = await db.query(
    `SELECT activa_ia FROM kanban_columnas
      WHERE id_configuracion = ? AND LOWER(estado_db) = LOWER(?)
        AND activo = 1 LIMIT 1`,
    { replacements: [id_configuracion, estado], type: db.QueryTypes.SELECT },
  );
  // Columna con IA activa → que responda la IA, no esto.
  return !col || Number(col.activa_ia) !== 1;
}

/* ═══════════════════════════════════════════════════════════
   3. Datos de la orden
   ═══════════════════════════════════════════════════════════ */

async function ultimaOrden(id_configuracion, telefono) {
  const last9 = String(telefono || '')
    .replace(/\D/g, '')
    .slice(-9);
  if (last9.length < 9) return null;
  const [row] = await db.query(
    `SELECT dropi_order_id, status, classified_status, city,
            shipping_company, shipping_guide, order_created_at, order_data
       FROM dropi_orders_cache
      WHERE id_configuracion = ?
        AND RIGHT(REGEXP_REPLACE(COALESCE(phone,''), '[^0-9]', ''), 9) = ?
      ORDER BY dropi_order_id DESC
      LIMIT 1`,
    { replacements: [id_configuracion, last9], type: db.QueryTypes.SELECT },
  );
  return row || null;
}

/* Rango típico de días compra→entrega de ESTA tienda a ESA ciudad, con los
   delivered_at reales. p25–p75 para no prometer el mejor caso ni asustar con
   el peor. null si todavía no hay historial suficiente. */
async function rangoDiasEntrega(id_configuracion, city) {
  const traer = (conCiudad) =>
    db.query(
      `SELECT DATEDIFF(delivered_at, order_created_at) AS dias
         FROM dropi_orders_cache
        WHERE id_configuracion = :cfg
          AND delivered_at IS NOT NULL
          AND order_created_at IS NOT NULL
          AND delivered_at > NOW() - INTERVAL 90 DAY
          AND DATEDIFF(delivered_at, order_created_at) BETWEEN 1 AND 20
          ${conCiudad ? 'AND city = :city' : ''}
        ORDER BY dias`,
      {
        replacements: { cfg: id_configuracion, city: city || '' },
        type: db.QueryTypes.SELECT,
      },
    );

  let filas = city ? await traer(true) : [];
  let ambito = 'ciudad';
  if (filas.length < 5) {
    filas = await traer(false);
    ambito = 'tienda';
  }
  if (filas.length < 5) return null;

  const dias = filas.map((f) => Number(f.dias));
  const p = (q) => dias[Math.min(dias.length - 1, Math.floor(dias.length * q))];
  const desde = Math.max(1, p(0.25));
  const hasta = Math.max(desde + 1, p(0.75));
  return { desde, hasta, ambito, muestras: dias.length };
}

/* ═══════════════════════════════════════════════════════════
   4. Composición de la respuesta
   ═══════════════════════════════════════════════════════════ */

function lineaTracking(orden) {
  const url = getTrackingUrl(orden.shipping_company, orden.shipping_guide);
  return url ? `Puedes ver el avance en tiempo real aquí:\n${url}` : '';
}

async function componerRespuesta({ intencion, orden, id_configuracion, cfg }) {
  const guia = String(orden.shipping_guide || '').trim();
  const entregada = orden.classified_status === 'entregada';

  if (intencion === 'guia') {
    if (!guia) {
      return `Tu pedido está confirmado y estamos preparando el envío 📦 Apenas se genere la guía te la enviamos por aquí.`;
    }
    const transportadora = String(orden.shipping_company || '').trim();
    const partes = [
      `Tu número de guía es *${guia}*${transportadora ? ` (${transportadora})` : ''} 📦`,
    ];
    const t = lineaTracking(orden);
    if (t) partes.push(t);
    return partes.join('\n');
  }

  if (intencion === 'retiro') {
    let order_data = null;
    try {
      order_data = JSON.parse(orden.order_data || 'null');
    } catch (_) {}
    const r = await resolverLugarRetiro({
      order: {
        id: orden.dropi_order_id,
        shipping_guide: guia,
        shipping_company: orden.shipping_company,
        city: orden.city,
        dir: order_data?.dir || null,
        country: order_data?.country || null,
      },
      timeoutMs: TIMEOUT_AGENCIA_MS,
    }).catch(() => null);

    const partes = [];
    if (r?.lugar) {
      partes.push(`Puedes retirar tu pedido en: *${r.lugar}* 📍`);
      partes.push(`Lleva tu cédula para el retiro.`);
    } else if (guia) {
      partes.push(
        `Tu pedido quedó para retiro en la agencia de la transportadora en tu ciudad 📍 Lleva tu cédula y tu número de guía: *${guia}*.`,
      );
    } else {
      return `Un asesor te confirma en un momento el punto exacto de retiro 🙌`;
    }
    const t = lineaTracking(orden);
    if (t) partes.push(t);
    return partes.join('\n');
  }

  // demora
  if (entregada) {
    return `Tu pedido ya figura como *entregado* ✅ Si aún no lo tienes en tus manos, avísanos por aquí y un asesor lo revisa de inmediato.`;
  }
  // Rango manual fijado por el negocio desde la pantalla del kanban: pisa el
  // cálculo automático. Si no hay (o es inválido), historial real como siempre.
  const manual = rangoManual(cfg);
  const rango = manual || (await rangoDiasEntrega(id_configuracion, orden.city));
  const partes = [];
  if (manual) {
    const dias =
      manual.desde === manual.hasta
        ? `de *${manual.desde} ${manual.desde === 1 ? 'día' : 'días'}*`
        : `de *${manual.desde} a ${manual.hasta} días*`;
    partes.push(
      `Tu pedido va en camino 🚚 El tiempo estimado de entrega es ${dias} desde la compra, aunque puede variar un poco según la zona.`,
    );
  } else if (rango) {
    const destino =
      rango.ambito === 'ciudad' && orden.city
        ? `a ${capitalizar(orden.city)}`
        : 'a tu ciudad';
    partes.push(
      `Tu pedido va en camino 🚚 Los pedidos ${destino} normalmente llegan entre *${rango.desde} y ${rango.hasta} días* desde la compra, aunque puede variar un poco según la zona.`,
    );
  } else {
    partes.push(
      `Tu pedido va en camino 🚚 La entrega normalmente toma de *2 a 5 días hábiles* según la ciudad; a zonas alejadas puede tardar un poco más.`,
    );
  }
  const t = lineaTracking(orden);
  if (t) partes.push(t);
  return partes.join('\n');
}

function capitalizar(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/(^|\s)\S/g, (c) => c.toUpperCase());
}

/* ═══════════════════════════════════════════════════════════
   5. Entrada desde el webhook
   ═══════════════════════════════════════════════════════════ */

/* No repetir la misma respuesta si el cliente insiste en ráfaga. */
async function yaSeRespondioHacePoco(id_configuracion, id_cliente, texto) {
  try {
    const [fila] = await db.query(
      `SELECT id FROM mensajes_clientes
        WHERE id_configuracion = ? AND celular_recibe = ?
          AND rol_mensaje = 1 AND texto_mensaje = ?
          AND created_at > NOW() - INTERVAL 10 MINUTE
        ORDER BY id DESC LIMIT 1`,
      {
        replacements: [id_configuracion, id_cliente, texto],
        type: db.QueryTypes.SELECT,
      },
    );
    return !!fila;
  } catch (_) {
    return false;
  }
}

async function intentarRespuestaLogistica({
  id_configuracion,
  id_cliente,
  telefono,
  business_phone_id,
  accessToken,
  estado_contacto,
  texto_mensaje,
  log,
}) {
  const decir = typeof log === 'function' ? log : async () => {};

  const intencion = detectarIntencion(texto_mensaje);
  if (!intencion) return { manejado: false };

  // Interruptor por cuenta: el negocio puede apagar el respondedor desde la
  // configuración del kanban y estas preguntas vuelven a quedar para el humano.
  const cfg = await getConfigRespondedor(id_configuracion);
  if (!cfg.activo) {
    await decir(`📦 logístico: apagado por configuración → no respondo`);
    return { manejado: false };
  }

  if (!(await esColumnaLogisticaSinIA(id_configuracion, estado_contacto))) {
    return { manejado: false };
  }

  const orden = await ultimaOrden(id_configuracion, telefono);
  if (!orden) return { manejado: false };

  const texto = await componerRespuesta({
    intencion,
    orden,
    id_configuracion,
    cfg,
  });
  if (!texto) return { manejado: false };

  if (await yaSeRespondioHacePoco(id_configuracion, id_cliente, texto)) {
    await decir(`📦 logístico: misma respuesta hace <10 min → no repito`);
    return { manejado: true };
  }

  await enviarMensajeWhatsapp({
    phone_whatsapp_to: telefono,
    texto_mensaje: texto,
    business_phone_id,
    accessToken,
    id_configuracion,
    responsable: RESPONSABLE,
    total_tokens: 0,
  });
  await decir(
    `📦 logístico: "${intencion}" respondido con orden ${orden.dropi_order_id} (col ${estado_contacto}) → sin IA`,
  );
  return { manejado: true, intencion, dropi_order_id: orden.dropi_order_id };
}

module.exports = {
  intentarRespuestaLogistica,
  detectarIntencion,
  rangoDiasEntrega,
  invalidarConfigRespondedor,
};
