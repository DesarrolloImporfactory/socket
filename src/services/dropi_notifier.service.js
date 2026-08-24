'use strict';

/**
 * services/dropi_notifier.service.js
 *
 * Lógica COMPARTIDA de notificaciones de estados Dropi.
 * Extraída de cron/syncDropiOrdersHourly.js (v7) SIN cambios de
 * comportamiento, para que el webhook de Dropi (tiempo real) y el cron
 * (red de seguridad) envíen los mismos templates sin duplicar código.
 *
 * Consumidores:
 *  - cron/syncDropiOrdersHourly.js        → upsertOrders + procesarTemplates
 *  - services/dropi_webhook_processor.service.js → ídem, por evento webhook
 *
 * Anti-duplicados cron↔webhook: reclamarEnvio() es atómico gracias al
 * UNIQUE uk_order_config_estado (dropi_order_id, id_configuracion,
 * estado_dropi) en dropi_plantillas_enviadas. Aunque ambos flujos procesen
 * la misma orden en paralelo, solo uno gana el derecho a enviar.
 */

const axios = require('axios');

const { db } = require('../database/config');
const DropiOrdersCache = require('../models/dropi_orders_cache.model');
// Normalización de teléfonos con libphonenumber (multipaís).
// toWhatsapp(phone, country_code) → internacional en dígitos, sin "+".
const { toWhatsapp, isValidPhone, toDropiLocal } = require('../utils/phoneFactor');
const {
  moverContactoOrigenPorOrden,
} = require('./contactoOrigenEnlace.service');
const {
  obtenerOCrearContactoWa,
} = require('../utils/unified/dedupeContacto');
const { verificarAccesoAutomatizaciones } = require('../utils/planAcceso');
const { resolverLugarRetiro } = require('../utils/lugarRetiroAgencia');

/* ═══════════════════════════════════════════════════════════
   Constantes
   ═══════════════════════════════════════════════════════════ */

const DELAY_BETWEEN_WA_SENDS = 800;
const META_API_VERSION = process.env.GRAPH_VERSION;

const SIEMPRE_TEMPLATE = new Set(['PENDIENTE CONFIRMACION']);

/**
 * Columnas donde, al mover el contacto, se agenda la secuencia de seguimiento
 * configurada en `configuracion_remarketing`. Es opt-in por partida doble: la
 * columna tiene que estar aquí Y el cliente tiene que haber configurado la
 * secuencia (activo=1). Sin ambas cosas no se envía nada.
 */
const COLUMNAS_CON_SEGUIMIENTO = new Set(['retiro_agencia']);

/**
 * Agenda el primer paso de la secuencia. Va con require perezoso porque
 * kanban_ia → dropiAutoOrder → seguimiento_plantillas → este archivo forman
 * un ciclo: pedirlo arriba deja el módulo a medio cargar según quién entre
 * primero.
 */
/**
 * Valores del body para las plantillas de recordatorio de agencia:
 *   {{1}} nombre · {{2}} agencia/ciudad · {{3}} guía · {{4}} días de permanencia
 *
 * Si un dato falta se manda un guion: Meta rechaza parámetros vacíos (132000)
 * y es preferible un "-" a que no salga el recordatorio.
 */
async function construirParamsRetiroAgencia({ id_configuracion, order }) {
  let dias = 7; // lo que realmente guarda Servientrega
  try {
    const [cfg] = await db.query(
      `SELECT dias_retiro_agencia FROM configuraciones WHERE id = ? LIMIT 1`,
      { replacements: [id_configuracion], type: db.QueryTypes.SELECT },
    );
    if (cfg?.dias_retiro_agencia) dias = Number(cfg.dias_retiro_agencia);
  } catch (_) {
    // columna aún no migrada → se usa el default
  }

  const nombre = `${order?.name || ''} ${order?.surname || ''}`.trim();
  // `dir` ya viene resuelto como LUGAR DE RETIRO por procesarTemplates
  // (agencia real de Servientrega, o la agencia que escribió el vendedor, o
  // "agencia de Servientrega en {ciudad}") — ver utils/lugarRetiroAgencia.
  // Nunca es el domicilio del cliente aunque la orden se haya creado así.
  const agencia = String(order?.dir || order?.city || '').trim();

  return [
    nombre || 'Hola',
    agencia || '-',
    String(order?.shipping_guide || '').trim() || '-',
    String(dias),
  ];
}

async function programarSeguimientoColumna(params) {
  try {
    const { programarRemarketingKanban } = require('./kanban_ia.service');
    await programarRemarketingKanban(params);
  } catch (e) {
    // Best-effort: el mensaje de estado ya salió; no se cae por esto.
    console.log(
      `[dropi-notifier] no se pudo agendar seguimiento (cfg ${params?.id_configuracion}, ${params?.estado_contacto}):`,
      e?.message,
    );
  }
}
const VENTANA_HORAS = 23;
const COLUMNA_ENTREGADA_DEFAULT = 'entregada';

/* ═══════════════════════════════════════════════════════════
   Mapeo: raw status Dropi → estado en dropi_plantillas_config
   ═══════════════════════════════════════════════════════════ */

function mapDropiStatusToEstadoConfig(rawStatus) {
  const s = String(rawStatus || '')
    .trim()
    .toUpperCase();

  if (s === 'PENDIENTE CONFIRMACION') return 'PENDIENTE CONFIRMACION';
  if (s === 'PENDIENTE') return 'PENDIENTE';
  if (s === 'GUIA_GENERADA') return 'GUIA GENERADA';

  if (
    s === 'CANCELADO' ||
    s.includes('CANCELADA') ||
    s === 'ANULADA' ||
    s === 'RECHAZADO' ||
    s === 'GUIA_ANULADA'
  )
    return 'CANCELADO';

  if (
    s.includes('RETIRO EN AGENCIA') ||
    s.includes('ENVÍO LISTO EN OFICINA') ||
    s === 'ENVIO LISTO EN OFICINA'
  )
    return 'RETIRO EN AGENCIA';

  if (
    s === 'ENTREGADO' ||
    s.includes('ENTREGADA') ||
    s === 'REPORTADO ENTREGADO' ||
    s.includes('REPORTADO ENTREGADO') ||
    s === 'ENTREGA DIGITALIZADA' ||
    s === 'CERTIFICACION DE PRUEBA DE ENTREGA'
  )
    return 'ENTREGADA';

  if (
    s.includes('DEVOLUCION') ||
    s.includes('DEVOLUCIÓN') ||
    s === 'DEVUELTO' ||
    s === 'CERTIFICACION DEVOLUCION AL REMITENTE' ||
    s === 'DESAPLICADO'
  )
    return 'DEVOLUCION';

  if (
    s.includes('NOVEDAD') ||
    s.includes('SOLUCION') ||
    s.includes('SOLUCIÓN') ||
    s === 'CON NOVEDAD' ||
    s === 'DESTINATARIO FALLECIDO' ||
    s.includes('DESTINATARIO RE-PROGRAMA') ||
    s.includes('DESTINATARIO SOLICITA') ||
    s.includes('DESTINATARIO INDICA') ||
    s.includes('FUERA DE COBERTURA') ||
    s.includes('OBSTRUCCIÓN EN LA VÍA') ||
    s.includes('PROBLEMAS DE ORDEN') ||
    s.includes('VISITA A DESTINATARIO') ||
    s.includes('ACCIDENTE EN CARRETERA') ||
    s.includes('EN ESPERA DE FIRMA') ||
    s.includes('INCONFORME')
  )
    return 'NOVEDAD';

  if (
    s === 'EN REPARTO' ||
    s === 'ZONA DE ENTREGA' ||
    s === 'EN DISTRIBUCION A CLIENTE' ||
    s === 'EN DISTRIBUCIÓN A CLIENTE' ||
    s.includes('EN DISTRIBUCION A') ||
    s.includes('EN DISTRIBUCIÓN A') ||
    s === 'EN CAMINO' ||
    s.includes('SALIDA A REPARTO') ||
    s.includes('REPARTIDOR ASIGNADO')
  )
    return 'EN TRANSITO';

  return null;
}

/* ═══════════════════════════════════════════════════════════
   classifyDropiStatus (para cache)
   ═══════════════════════════════════════════════════════════ */

function classifyDropiStatus(status) {
  const s = String(status || '')
    .trim()
    .toUpperCase();

  if (
    s === 'ENTREGADO' ||
    s.includes('ENTREGADA') ||
    s === 'REPORTADO ENTREGADO' ||
    s.includes('REPORTADO ENTREGADO') ||
    s === 'ENTREGA DIGITALIZADA' ||
    s === 'CERTIFICACION DE PRUEBA DE ENTREGA'
  )
    return 'entregada';

  if (
    s.includes('DEVOLUCION') ||
    s.includes('DEVOLUCIÓN') ||
    s === 'DEVUELTO' ||
    s === 'CERTIFICACION DEVOLUCION AL REMITENTE' ||
    s === 'DESAPLICADO'
  )
    return 'devolucion';

  if (
    s.includes('CANCELADO') ||
    s.includes('CANCELADA') ||
    s === 'ANULADA' ||
    s === 'RECHAZADO' ||
    s === 'GUIA_ANULADA'
  )
    return 'cancelada';

  if (s === 'PENDIENTE' || s === 'PENDIENTE CONFIRMACION') return 'pendiente';

  if (
    s.includes('RETIRO EN AGENCIA') ||
    s.includes('ENTREGA EN AGENCIA') ||
    s.includes('ENVÍO LISTO EN OFICINA') ||
    s === 'ENVIO LISTO EN OFICINA'
  )
    return 'retiro_agencia';

  // Novedad YA resuelta ("SOLUCIONADA" / "SOLUCION APROBADA") → la orden
  // sigue en ruta; NO debe contar como novedad (antes la atrapaba el bloque
  // de abajo por contener "NOVEDAD"/"SOLUCION" y quedaba pegada en novedad).
  // OJO: "SOLUCION INCORRECTA" NO entra aquí (la solución falló → novedad).
  if (s.includes('SOLUCIONAD') || s.includes('SOLUCION APROBADA'))
    return 'en_transito';

  if (
    s.includes('NOVEDAD') ||
    s.includes('SOLUCION') ||
    s.includes('SOLUCIÓN') ||
    s === 'CON NOVEDAD' ||
    s === 'DESTINATARIO FALLECIDO' ||
    s.includes('DESTINATARIO RE-PROGRAMA') ||
    s.includes('DESTINATARIO SOLICITA') ||
    s.includes('DESTINATARIO INDICA') ||
    s.includes('FUERA DE COBERTURA') ||
    s.includes('OBSTRUCCIÓN EN LA VÍA') ||
    s.includes('PROBLEMAS DE ORDEN') ||
    s.includes('VISITA A DESTINATARIO') ||
    s.includes('ACCIDENTE EN CARRETERA') ||
    s.includes('EN ESPERA DE FIRMA') ||
    s.includes('INCONFORME')
  )
    return 'novedad';

  if (
    s.includes('INDEMNIZ') ||
    s.includes('SINIESTRO') ||
    s.includes('INCAUTADO') ||
    s.includes('HURTAD') ||
    s.includes('AVERÍA')
  )
    return 'indemnizada';

  if (s === 'GUIA_GENERADA') return 'guia_generada';

  if (
    s === 'EN REPARTO' ||
    s === 'ZONA DE ENTREGA' ||
    s === 'EN DISTRIBUCION A CLIENTE' ||
    s === 'EN DISTRIBUCIÓN A CLIENTE' ||
    s.includes('EN DISTRIBUCION A') ||
    s.includes('EN DISTRIBUCIÓN A') ||
    s === 'EN CAMINO' ||
    s.includes('SALIDA A REPARTO') ||
    s.includes('REPARTIDOR ASIGNADO') ||
    s === 'INTENTO DE ENTREGA' ||
    s === 'LISTO PARA ENTREGAR' ||
    s.includes('SALIO A RUTA')
  )
    return 'en_reparto';

  if (
    s.includes('TRÁNSITO') ||
    s.includes('TRANSITO') ||
    s.includes('EN RUTA') ||
    s.includes('BODEGA') ||
    s.includes('EMBARCANDO') ||
    s.includes('RECOLECT') ||
    s.includes('RECOGIDO') ||
    s.includes('ASIGNADO') ||
    s.includes('PICKING') ||
    s.includes('PACKING') ||
    s.includes('GENERADO') ||
    s.includes('GENERADA') ||
    s.includes('PREPARADO') ||
    s.includes('INVENTARIO') ||
    s.includes('INGRES') ||
    s.includes('RECIBIDO') ||
    s === 'POR RECOLECTAR' ||
    s === 'PROCESAMIENTO' ||
    // Estados logísticos de transportadoras que antes caían en 'otro'
    s.includes('CENTRO DE') ||
    s.includes('DISTRIBUCION') ||
    s.includes('DISTRIBUCIÓN') ||
    s.includes('CIUDAD DE') ||
    s.includes('ARRIBAD') ||
    s.includes('DESEMBARQUE') ||
    s.includes('RECEPCION') ||
    s.includes('RECEPCIÓN') ||
    s.includes('INSTALACION') ||
    s.includes('INSTALACIÓN') ||
    s.includes('DESPACHAD') ||
    s.includes('A TRANSPORTADORA') ||
    s.includes('LLEGANDO') ||
    s.includes('CEDIS') ||
    s.includes('CIRCUITO') ||
    s.includes('PREPARANDO RUTA')
  )
    return 'en_transito';

  return 'otro';
}

/* ═══════════════════════════════════════════════════════════
   Helpers generales
   ═══════════════════════════════════════════════════════════ */

/**
 * Internacional para WhatsApp (sin "+"), según el país de la integración.
 * Delega en libphonenumber (toWhatsapp). Si no se pasa countryCode, asume EC,
 * idéntico al comportamiento histórico (962803007 → 593962803007).
 */
function normalizePhone(phone, countryCode = 'EC') {
  return toWhatsapp(phone, countryCode) || null;
}

/**
 * Teléfono CONFIABLE de la orden, siempre dentro de la misma configuración.
 *
 * Si el phone que trae Dropi está incompleto (le faltan dígitos), intenta
 * recuperar el número real SIN salirse de la config:
 *   1) la orden REEMPLAZADA gemela en el cache (el clon que Dropi crea al
 *      editar/regenerar hereda el order_created_at exacto de la original);
 *   2) un contacto de ESA config cuyo número nacional empiece con los
 *      dígitos mochos.
 * Devuelve el número recuperado (formato nacional) o null si no hay forma
 * segura de saberlo. null = NO notificar: un número mocho matchearía por
 * sufijo (LIKE %) al contacto de OTRA persona y el seguimiento le llegaría
 * al cliente equivocado.
 */
async function resolverTelefonoConfiable({
  order,
  id_configuracion,
  country_code = 'EC',
}) {
  const raw = order?.phone || '';
  if (!raw) return null;
  if (isValidPhone(raw, country_code)) return raw;

  const bad = String(raw).replace(/\D/g, '');
  if (!bad || bad.length < 7) return null;

  // 1) gemela REEMPLAZADA — se compara cache contra cache (mismo
  //    order_created_at) para no pelear con formatos/zonas horarias.
  try {
    const twins = await db.query(
      `SELECT b.phone
         FROM dropi_orders_cache a
         JOIN dropi_orders_cache b
           ON b.id_configuracion = a.id_configuracion
          AND b.order_created_at = a.order_created_at
          AND b.dropi_order_id <> a.dropi_order_id
        WHERE a.id_configuracion = ? AND a.dropi_order_id = ?
          AND b.status = 'REEMPLAZADA'`,
      {
        replacements: [id_configuracion, order.id || 0],
        type: db.QueryTypes.SELECT,
      },
    );
    for (const t of twins) {
      const local = toDropiLocal(t.phone, country_code);
      if (isValidPhone(local, country_code) && local.startsWith(bad)) {
        return local;
      }
    }
  } catch (err) {}

  // 2) contacto de ESTA config que empiece con los dígitos mochos
  try {
    const rows = await db.query(
      `SELECT celular_cliente
         FROM clientes_chat_center
        WHERE id_configuracion = ? AND deleted_at IS NULL
          AND REPLACE(celular_cliente, ' ', '') LIKE ?
        LIMIT 20`,
      {
        replacements: [id_configuracion, `%${bad}%`],
        type: db.QueryTypes.SELECT,
      },
    );
    for (const r of rows) {
      const local = toDropiLocal(r.celular_cliente, country_code);
      if (isValidPhone(local, country_code) && local.startsWith(bad)) {
        return local;
      }
    }
  } catch (err) {}

  return null;
}

function safeJsonParse(str, fallback) {
  try {
    return str ? JSON.parse(str) : fallback;
  } catch (_) {
    return fallback;
  }
}

/* ═══════════════════════════════════════════════════════════
   Tracking URL / Guía PDF
   ═══════════════════════════════════════════════════════════ */

function getTrackingUrl(shippingCompany, guide) {
  if (!guide) return '';
  const comp = String(shippingCompany || '').toUpperCase();
  const g = String(guide).trim();
  if (
    comp.includes('LAAR') ||
    g.startsWith('LC') ||
    g.startsWith('IMP') ||
    g.startsWith('MKP')
  )
    return `https://fenixoper.laarcourier.com/Tracking/Guiacompleta.aspx?guia=${encodeURIComponent(g)}`;
  if (comp.includes('GINTRACOM') || g.startsWith('D0') || g.startsWith('I0'))
    return `https://ec.gintracom.site/web/site/tracking?guia=${encodeURIComponent(g)}`;
  if (comp.includes('VELOCES') || g.startsWith('V'))
    return `https://tracking.veloces.app/tracking-client/${encodeURIComponent(g)}`;
  if (comp.includes('URBANO') || g.startsWith('WYB'))
    return `https://app.urbano.com.ec/plugin/etracking/etracking/?guia=${encodeURIComponent(g)}`;
  if (comp.includes('SERVIENTREGA'))
    return `https://www.servientrega.com.ec/Tracking/?guia=${encodeURIComponent(g)}&tipo=GUIA`;
  return '';
}

/**
 * Fallback para el flujo WEBHOOK: el payload del webhook de Dropi NUNCA
 * trae guia_urls3, pero sí sticker + country + shipping_company, y el path
 * S3 real siempre es `<pais>/guias/<transportadora>/<sticker>` (verificado
 * contra 5000 órdenes reales de 7 días: servientrega, gintracom,
 * laarcourier, veloces, urbano, quality-post y tiui, en EC y MX; 0 fallos).
 *
 * Se reconstruye SOLO si los 3 campos pasan validación estricta; ante
 * cualquier cosa rara se devuelve '' (misma degradación que hoy cuando la
 * orden aún no tiene guía: la variable va vacía).
 */
function reconstructGuiaPdfPath(order) {
  const sticker = String(order?.sticker || '').trim();
  const country = String(order?.country || '').trim();
  const company = String(order?.shipping_company || '').trim();
  if (!sticker || !country || !company) return '';

  // El sticker es un nombre de archivo PDF plano (sin rutas embebidas)
  if (!/\.pdf$/i.test(sticker) || /[/\\]/.test(sticker)) return '';

  // minúsculas + sin tildes (MÉXICO → mexico), igual que el path S3 real
  const norm = (s) =>
    s
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '');

  const paisSeg = norm(country);
  const compSeg = norm(company);

  // Segmentos de path válidos observados: solo letras para el país
  // (ecuador, mexico) y letras/números/guiones para la transportadora
  // (servientrega, quality-post). Cualquier otro formato → no reconstruir.
  if (!/^[a-z]+$/.test(paisSeg)) return '';
  if (!/^[a-z0-9-]+$/.test(compSeg)) return '';

  return `${paisSeg}/guias/${compSeg}/${sticker}`;
}

function getGuiaPdfUrl(order) {
  const guiaPath = order.guia_urls3;
  // Sin guia_urls3 (payload de webhook): intentar reconstrucción segura
  if (!guiaPath) return reconstructGuiaPdfPath(order);
  const CF_PREFIX = 'https://d39ru7awumhhs2.cloudfront.net/';
  if (guiaPath.startsWith(CF_PREFIX)) return guiaPath.replace(CF_PREFIX, '');
  return guiaPath;
}

/* ═══════════════════════════════════════════════════════════
   Resolver variable de template desde la orden Dropi
   ═══════════════════════════════════════════════════════════ */

function resolveVariable(varName, order) {
  const details = Array.isArray(order.orderdetails) ? order.orderdetails : [];

  switch (varName) {
    case 'nombre':
      return `${order.name || ''} ${order.surname || ''}`.trim() || 'Cliente';
    case 'contenido':
      // Resumen ya armado por el origen. Lo usa Aliclik, cuyo listado no
      // devuelve el nombre por item (solo skuId) sino un `productDetail`
      // textual. Las órdenes de Dropi nunca traen este campo, así que para
      // ellas el comportamiento es idéntico al de siempre.
      if (order.contenido_texto) return String(order.contenido_texto);
      if (!details.length) return 'Tu pedido';
      return details
        .map((d) => `${d?.quantity || 1} x ${d?.product?.name || 'Producto'}`)
        .join(', ');
    case 'direccion':
      return order.dir || 'Dirección no disponible';
    case 'costo':
      return String(order.total_order || '0');
    case 'ciudad':
      return order.city || '';
    case 'provincia':
      return order.state || '';
    case 'numero_guia':
      return order.shipping_guide || '';
    case 'transportadora':
      return order.shipping_company || '';
    case 'tracking':
      return getTrackingUrl(order.shipping_company, order.shipping_guide);
    case 'guia_pdf':
      return getGuiaPdfUrl(order);
    case 'order_id':
      return String(order.id || '');
    case 'telefono':
      return order.phone || '';
    default:
      return '';
  }
}

function interpolarBodyText(bodyText, components) {
  if (!bodyText) return null;
  let resultado = bodyText;
  const bodyComp = components.find((c) => c.type === 'body');
  if (bodyComp?.parameters) {
    bodyComp.parameters.forEach((p, i) => {
      resultado = resultado.replace(`{{${i + 1}}}`, p.text || '');
    });
  }
  return resultado;
}

function buildRutaArchivo(order, estadoConfig) {
  const details = Array.isArray(order.orderdetails) ? order.orderdetails : [];
  return {
    nombre: `${order.name || ''} ${order.surname || ''}`.trim(),
    direccion: order.dir || '',
    email: '',
    celular: order.phone || '',
    order_id: String(order.id || ''),
    contenido:
      order.contenido_texto ||
      details
        .map((d) => ` ${d?.quantity || 1} x ${d?.product?.name || 'Producto'} `)
        .join(','),
    costo: String(order.total_order || '0'),
    ciudad: order.city || '',
    tracking: getTrackingUrl(order.shipping_company, order.shipping_guide),
    transportadora: order.shipping_company || '',
    numero_guia: order.shipping_guide || '',
    estado_notificacion: estadoConfig,
    source: 'wa',
  };
}

/**
 * Meta rechaza parámetros de template con \n, \t o 4+ espacios seguidos
 * (error 132000) y con texto vacío. Las direcciones de agencia que manda
 * Dropi a veces traen TABs (caso real: orden 6077513, "AGENCIA CUENCA_...\t...")
 * y tumbaban el envío en silencio para ESA orden en cada corrida.
 */
function sanitizeParamText(text) {
  return String(text ?? '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/ {4,}/g, '   ')
    .trim()
    .slice(0, 1024);
}

function buildTemplateComponents(parametrosJson, order) {
  const config = safeJsonParse(parametrosJson, null);
  if (!config) return [];
  const components = [];
  if (Array.isArray(config.body) && config.body.length > 0) {
    components.push({
      type: 'body',
      parameters: config.body.map((varName) => ({
        type: 'text',
        // '-' porque Meta también rechaza params vacíos
        text: sanitizeParamText(resolveVariable(varName, order)) || '-',
      })),
    });
  }
  if (Array.isArray(config.buttons) && config.buttons.length > 0) {
    for (const btn of config.buttons) {
      const idx = btn.index != null ? btn.index : 0;
      /* Mismo '-' que el body: Meta rechaza el parámetro vacío con 132000 y
         tumba el envío entero. Un botón que lleva a un link muerto es peor
         que nada, pero mucho menos malo que no avisarle al cliente que su
         pedido llegó — y además, sin envío el notifier tampoco lo mueve de
         columna. Hoy no ocurre (0 de 8.614 órdenes en agencia sin guía),
         queda como red de seguridad para otras plantillas con botón. */
      const value =
        sanitizeParamText(resolveVariable(btn.variable || '', order)) || '-';
      components.push({
        type: 'button',
        sub_type: 'url',
        index: String(idx),
        parameters: [{ type: 'text', text: value }],
      });
    }
  }
  return components;
}

/* ═══════════════════════════════════════════════════════════
   Upsert órdenes al cache
   ═══════════════════════════════════════════════════════════ */

async function upsertOrders(cacheInsertFields, orders) {
  if (!orders.length) return;
  const bulk = orders.map((o) => {
    const details = Array.isArray(o.orderdetails) ? o.orderdetails : [];
    const productNames = details.map((d) => d?.product?.name).filter(Boolean);
    return {
      dropi_order_id: o.id,
      ...cacheInsertFields,
      status: o.status || null,
      classified_status: classifyDropiStatus(o.status),
      total_order: Number(o.total_order || 0),
      name: o.name || null,
      surname: o.surname || null,
      phone: o.phone || null,
      city: o.city || null,
      shipping_company: o.shipping_company || null,
      shipping_guide: o.shipping_guide || null,
      product_names: JSON.stringify(productNames),
      order_created_at: o.created_at || null,
      order_data: JSON.stringify(o),
      synced_at: new Date(),
      // shop: origen de la orden (IMPORSUIT/SHOPIFY/null). Antes no se
      // persistían y quedaban NULL aunque el JSON sí los traía.
      shop_id: o.shop_id ?? o.shop?.id ?? null,
      shop_type: o.shop?.type ?? null,
      shop_name: o.shop?.name ?? null,
    };
  });
  for (let i = 0; i < bulk.length; i += 200) {
    await DropiOrdersCache.bulkCreate(bulk.slice(i, i + 200), {
      updateOnDuplicate: [
        'status',
        'classified_status',
        'total_order',
        'name',
        'surname',
        'phone',
        'city',
        'shipping_company',
        'shipping_guide',
        'product_names',
        // Mantiene la fecha alineada con la fuente más fresca (el webhook ya
        // convierte UTC→local con dropiDateToLocal); además repara filas
        // viejas corridas +5h. Clave para la gemela REEMPLAZADA, que se
        // busca por order_created_at exacto.
        'order_created_at',
        'order_data',
        'synced_at',
        'shop_id',
        'shop_type',
        'shop_name',
      ],
    });
  }
}

/* ═══════════════════════════════════════════════════════════
   Credenciales WA / plantillas / kanban
   ═══════════════════════════════════════════════════════════ */

async function getWaCredentials(id_configuracion) {
  const [row] = await db.query(
    `SELECT id_telefono AS phone_number_id, token AS waba_token, telefono,
            id_whatsapp AS waba_id
     FROM configuraciones WHERE id = ? AND id_telefono IS NOT NULL AND token IS NOT NULL LIMIT 1`,
    { replacements: [id_configuracion], type: db.QueryTypes.SELECT },
  );
  return row || null;
}

/* Plantillas APROBADAS de la WABA, cacheadas 30 min por cuenta.
   Sin esto, una config con plantillas copiadas de otra cuenta reintenta el
   mismo envío fallido cada 15 min contra Meta, para siempre. */
const CACHE_TEMPLATES = new Map();
const TTL_TEMPLATES_MS = 30 * 60 * 1000;

async function getTemplatesAprobadas(waba_id, token) {
  if (!waba_id || !token) return null; // null = no se pudo saber → no filtrar
  const hit = CACHE_TEMPLATES.get(waba_id);
  if (hit && Date.now() - hit.at < TTL_TEMPLATES_MS) return hit.set;

  try {
    const url = `https://graph.facebook.com/${META_API_VERSION}/${waba_id}/message_templates?fields=name,status&limit=500`;
    const resp = await axios.get(url, {
      headers: { Authorization: `Bearer ${token}` },
      timeout: 15000,
    });
    const set = new Set(
      (resp.data?.data || [])
        .filter((t) => String(t.status).toUpperCase() === 'APPROVED')
        .map((t) => t.name),
    );
    CACHE_TEMPLATES.set(waba_id, { at: Date.now(), set });
    return set;
  } catch (e) {
    // Si Meta no responde no bloqueamos los envíos: se intenta como antes.
    console.error(
      `[notifier] no se pudo listar templates de WABA ${waba_id}:`,
      e?.response?.data?.error?.message || e.message,
    );
    return null;
  }
}

/**
 * Plantillas activas de una configuración para un proveedor de fulfillment.
 *
 * `dropi_plantillas_config` es en la práctica una tabla genérica ("estado
 * canónico → plantilla + columna destino"); la columna `proveedor` es lo que
 * permite que Aliclik use la misma tabla y la misma pantalla sin pisar la
 * configuración de Dropi. El default 'dropi' deja intactos a los llamadores
 * existentes.
 */
async function getPlantillasActivas(id_configuracion, proveedor = 'dropi') {
  const rows = await db.query(
    `SELECT estado_dropi, nombre_template, language_code,
            mensaje_rapido, usar_respuesta_rapida, parametros_json, body_text,
            columna_destino
     FROM dropi_plantillas_config
     WHERE id_configuracion = ? AND proveedor = ? AND activo = 1
       AND (
         (nombre_template IS NOT NULL AND nombre_template != '')
         OR (columna_destino IS NOT NULL AND columna_destino != '')
       )`,
    {
      replacements: [id_configuracion, proveedor],
      type: db.QueryTypes.SELECT,
    },
  );
  const map = {};
  for (const r of rows) {
    const nombreTemplate = r.nombre_template || null;
    map[r.estado_dropi] = {
      nombre_template: nombreTemplate,
      language_code: r.language_code || 'es',
      mensaje_rapido: r.mensaje_rapido || null,
      usar_respuesta_rapida: !!r.usar_respuesta_rapida,
      parametros_json: r.parametros_json || null,
      body_text: r.body_text || null,
      columna_destino: r.columna_destino || null,
      // Estado configurado para SOLO reubicar al cliente en el kanban cuando
      // Dropi notifica, sin enviar ningún mensaje (plantilla ni resp. rápida).
      solo_mover: !nombreTemplate && !!r.columna_destino,
    };
  }
  return map;
}

async function getColumnaPrincipalDropi(id_configuracion) {
  const [dropiCol] = await db.query(
    `SELECT id, estado_db, 'dropi' AS tipo FROM kanban_columnas
     WHERE id_configuracion = ? AND es_dropi_principal = 1 LIMIT 1`,
    { replacements: [id_configuracion], type: db.QueryTypes.SELECT },
  );
  if (dropiCol) return dropiCol;

  const [principalCol] = await db.query(
    `SELECT id, estado_db, 'principal' AS tipo FROM kanban_columnas
     WHERE id_configuracion = ? AND es_principal = 1 LIMIT 1`,
    { replacements: [id_configuracion], type: db.QueryTypes.SELECT },
  );
  if (principalCol) return principalCol;
  return null;
}

/* ¿Este teléfono tiene una orden MÁS NUEVA y viva en esta config?

   Es el patrón del rescate manual: el bot (o alguien) creó una orden con
   datos malos, el equipo la CANCELA en Dropi y crea otra bien. El evento
   CANCELADO de la vieja llegaba igual —por el cron o por el webhook— y movía
   el chat a la columna de cancelados, enterrando como "cancelado" a un
   comprador con pedido vigente. Caso 285 (2026-08-19): orden 6599680
   cancelada + 6601103 PENDIENTE viva del mismo teléfono, y el chat quedó en
   "cancelados".

   "Más nueva" = dropi_order_id mayor (los ids de Dropi crecen). La ventana de
   30 días acota el scan y evita que una orden vieja sin relación bloquee un
   cancelado legítimo meses después. Best-effort: ante cualquier error se
   responde false y el flujo sigue como siempre. */
async function hayOrdenVivaPosterior({
  id_configuracion,
  phone,
  dropi_order_id,
}) {
  const last9 = String(phone || '')
    .replace(/\D/g, '')
    .slice(-9);
  if (last9.length < 9) return false;
  try {
    const [row] = await db.query(
      `SELECT dropi_order_id FROM dropi_orders_cache
        WHERE id_configuracion = ?
          AND dropi_order_id > ?
          AND classified_status <> 'cancelada'
          AND created_at >= NOW() - INTERVAL 30 DAY
          AND RIGHT(REGEXP_REPLACE(COALESCE(phone, ''), '[^0-9]', ''), 9) = ?
        LIMIT 1`,
      {
        replacements: [id_configuracion, dropi_order_id, last9],
        type: db.QueryTypes.SELECT,
      },
    );
    return !!row;
  } catch (_) {
    return false;
  }
}

async function actualizarEstadoContactoEntregado({
  id_configuracion,
  telefono,
  columnaDestino,
  country_code = 'EC',
}) {
  const phoneNorm = normalizePhone(telefono, country_code);
  if (!phoneNorm || !columnaDestino || !id_configuracion) return false;
  try {
    const [, meta] = await db.query(
      `UPDATE clientes_chat_center
         SET estado_contacto = ?
       WHERE id_configuracion = ?
         AND deleted_at IS NULL
         AND (estado_contacto IS NULL OR estado_contacto != ?)
         AND (REPLACE(celular_cliente, ' ', '') = ?
              OR telefono_limpio = ?
              OR celular_cliente LIKE ?)`,
      {
        replacements: [
          columnaDestino,
          id_configuracion,
          columnaDestino,
          phoneNorm,
          phoneNorm,
          `%${phoneNorm.slice(-9)}`,
        ],
        type: db.QueryTypes.UPDATE,
      },
    );
    const affected = meta?.affectedRows ?? meta ?? 0;
    return affected > 0;
  } catch (err) {
    return false;
  }
}

/* ═══════════════════════════════════════════════════════════
   Dedupe de envíos (dropi_plantillas_enviadas)
   ═══════════════════════════════════════════════════════════ */

async function yaFueEnviado(dropi_order_id, id_configuracion, estado_dropi) {
  const [row] = await db.query(
    `SELECT id FROM dropi_plantillas_enviadas
     WHERE dropi_order_id = ? AND id_configuracion = ? AND estado_dropi = ? LIMIT 1`,
    {
      replacements: [dropi_order_id, id_configuracion, estado_dropi],
      type: db.QueryTypes.SELECT,
    },
  );
  return !!row;
}

/* Dedupe cross-system para PENDIENTE CONFIRMACION
   Verifica si ya se envió la MISMA orden (mismo phone + mismo total) en las
   últimas 72h, ya sea desde Shopify webhook o desde el cron de Dropi. La
   ventana es de 72h porque la orden de Shopify se confirma al instante pero
   en Dropi puede aparecer ~1 día después (antes eran 24h y se colaban dobles).
   El total distingue un 2º pedido REAL del mismo cliente (que sí debe
   confirmarse) de la misma orden vista por los dos sistemas. Filas viejas sin
   total (pre-fix) caen al dedupe por phone. */
async function yaSeEnvioPendienteConfPorPhone(
  id_configuracion,
  phone,
  country_code = 'EC',
  total = null,
) {
  if (!phone) return false;
  const phoneNorm = normalizePhone(phone, country_code);
  if (!phoneNorm) return false;
  const phone9 = phoneNorm.slice(-9);
  const tot = Number(total) || 0;

  const [row] = await db.query(
    `SELECT id, source FROM dropi_plantillas_enviadas
     WHERE id_configuracion = ?
       AND estado_dropi = 'PENDIENTE CONFIRMACION'
       AND (phone = ? OR phone LIKE ?)
       AND (total_order IS NULL OR ? = 0 OR ABS(total_order - ?) < 0.5)
       AND sent_at > NOW() - INTERVAL 72 HOUR
     LIMIT 1`,
    {
      replacements: [id_configuracion, phoneNorm, `%${phone9}`, tot, tot],
      type: db.QueryTypes.SELECT,
    },
  );
  return !!row;
}

/* Reclama el envío ANTES de mandar el mensaje. Atómico gracias al UNIQUE
   uk_order_config_estado (dropi_order_id, id_configuracion, estado_dropi).
   Devuelve true si ESTA corrida ganó el derecho a enviar; false si ya estaba
   reclamado/enviado por otra corrida (→ no reenviar).
   Cierra el hueco de duplicados: aunque fallen las escrituras DB POST-envío,
   el registro anti-duplicado ya existe, así que nunca se reenvía. */
async function reclamarEnvio({
  dropi_order_id,
  id_configuracion,
  estado_dropi,
  phone,
  template_name,
  total = null,
  // Con qué guía salió el mensaje. Lo usa renotificarSiCambioGuia() para
  // detectar que Dropi la reemplazó después.
  shipping_guide = null,
}) {
  const conGuia = await tieneColumnaGuia();

  const cols = [
    'dropi_order_id',
    'id_configuracion',
    'estado_dropi',
    'phone',
    'template_name',
    'total_order',
  ];
  const vals = [
    dropi_order_id,
    id_configuracion,
    estado_dropi,
    phone || null,
    template_name || null,
    Number(total) || null,
  ];
  if (conGuia) {
    cols.push('shipping_guide');
    vals.push(String(shipping_guide || '').trim() || null);
  }

  const [res] = await db.query(
    `INSERT IGNORE INTO dropi_plantillas_enviadas
       (${cols.join(', ')})
     VALUES (${cols.map(() => '?').join(', ')})`,
    { replacements: vals },
  );
  // mysql2 ResultSetHeader: affectedRows=1 → insertó (reclamó);
  // 0 → ya existía (INSERT IGNORE lo ignoró) → NO reenviar.
  return Number(res?.affectedRows || 0) === 1;
}

/* Libera el reclamo SOLO si el envío a Meta falló, para reintentar luego. */
async function liberarEnvio({
  dropi_order_id,
  id_configuracion,
  estado_dropi,
}) {
  await db.query(
    `DELETE FROM dropi_plantillas_enviadas
     WHERE dropi_order_id = ? AND id_configuracion = ? AND estado_dropi = ?`,
    {
      replacements: [dropi_order_id, id_configuracion, estado_dropi],
      type: db.QueryTypes.DELETE,
    },
  );
}

/* Completa wa_message_id/template_name del reclamo tras un envío exitoso.
   Best-effort: si falla, no pasa nada (el mensaje ya salió y está marcado). */
async function completarEnvio({
  dropi_order_id,
  id_configuracion,
  estado_dropi,
  template_name,
  wa_message_id,
}) {
  await db.query(
    `UPDATE dropi_plantillas_enviadas
     SET wa_message_id = ?, template_name = ?
     WHERE dropi_order_id = ? AND id_configuracion = ? AND estado_dropi = ?`,
    {
      replacements: [
        wa_message_id || null,
        template_name || null,
        dropi_order_id,
        id_configuracion,
        estado_dropi,
      ],
      type: db.QueryTypes.UPDATE,
    },
  );
}

/* ═══════════════════════════════════════════════════════════
   Clientes / mensajes del chat center
   ═══════════════════════════════════════════════════════════ */

/* crearSiNoExiste=false → solo busca. Se usa ANTES de enviar: si creáramos el
   contacto ahí y el envío fallaba, quedaba un contacto sin un solo mensaje
   ensuciando la columna del kanban. */
async function resolverClientes({
  id_configuracion,
  phoneNorm,
  phone_number_id,
  telefonoConfig,
  crearSiNoExiste = true,
}) {
  const [clienteRow] = await db.query(
    `SELECT id FROM clientes_chat_center
     WHERE id_configuracion = ? AND deleted_at IS NULL
       AND (REPLACE(celular_cliente, ' ', '') = ? OR telefono_limpio = ? OR celular_cliente LIKE ?)
     ORDER BY id DESC LIMIT 1`,
    {
      replacements: [
        id_configuracion,
        phoneNorm,
        phoneNorm,
        `%${phoneNorm.slice(-9)}`,
      ],
      type: db.QueryTypes.SELECT,
    },
  );

  let clienteId = clienteRow?.id || null;

  if (!clienteId && crearSiNoExiste) {
    // Buscar-o-crear por identidad: tolera perder la carrera contra otro
    // proceso (el índice uq_ccc_dedupe rechaza al segundo). Aquí el template
    // ya se envió, así que reventar dejaría el mensaje fuera del chat.
    clienteId = await obtenerOCrearContactoWa({
      id_configuracion,
      telefono: phoneNorm,
      uid_cliente: phone_number_id,
    });
  }

  let idClienteConfig = null;
  if (telefonoConfig) {
    const telCfgLimpio = String(telefonoConfig).replace(/\D/g, '');
    if (telCfgLimpio) {
      const [cfgRow] = await db.query(
        `SELECT id FROM clientes_chat_center
         WHERE id_configuracion = ?
           AND (REPLACE(celular_cliente, ' ', '') = ? OR telefono_limpio = ?)
         LIMIT 1`,
        {
          replacements: [id_configuracion, telCfgLimpio, telCfgLimpio],
          type: db.QueryTypes.SELECT,
        },
      );
      idClienteConfig = cfgRow?.id || null;
    }
  }

  return { clienteId, idClienteConfig };
}

async function registrarMensajeEnChat({
  id_configuracion,
  phone_number_id,
  clienteId,
  idClienteConfig,
  phoneNorm,
  tipoEnvio,
  textoMensaje,
  templateName,
  languageCode,
  waMessageId,
  rutaArchivo,
  jsonMensaje,
  // Quién aparece como emisor en el chat. Por defecto el notifier de Dropi;
  // otros orígenes de seguimiento (bot de WhatsApp) mandan el suyo.
  responsable = 'Dropi Status',
}) {
  try {
    await db.query(
      `INSERT INTO mensajes_clientes
         (id_configuracion, id_cliente, mid_mensaje, tipo_mensaje, rol_mensaje,
          celular_recibe, responsable, texto_mensaje, ruta_archivo,
          json_mensaje, visto, uid_whatsapp, id_wamid_mensaje,
          template_name, language_code, informacion_suficiente)
       VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, 1)`,
      {
        replacements: [
          id_configuracion,
          idClienteConfig || clienteId,
          phone_number_id,
          tipoEnvio === 'template' ? 'template' : 'text',
          clienteId,
          responsable || 'Dropi Status',
          textoMensaje || '',
          rutaArchivo ? JSON.stringify(rutaArchivo) : null,
          jsonMensaje ? JSON.stringify(jsonMensaje) : null,
          phoneNorm,
          waMessageId || null,
          tipoEnvio === 'template' ? templateName || null : null,
          tipoEnvio === 'template' ? languageCode || null : null,
        ],
        type: db.QueryTypes.INSERT,
      },
    );
  } catch (err) {}
}

async function verificarVentana24h(id_configuracion, phoneNorm) {
  const [clienteRow] = await db.query(
    `SELECT id, ultimo_mensaje_at, ultimo_rol_mensaje
     FROM clientes_chat_center
     WHERE id_configuracion = ? AND deleted_at IS NULL
       AND (REPLACE(celular_cliente, ' ', '') = ? OR telefono_limpio = ? OR celular_cliente LIKE ?)
     ORDER BY id DESC LIMIT 1`,
    {
      replacements: [
        id_configuracion,
        phoneNorm,
        phoneNorm,
        `%${phoneNorm.slice(-9)}`,
      ],
      type: db.QueryTypes.SELECT,
    },
  );

  if (!clienteRow || !clienteRow.ultimo_mensaje_at) return false;

  if (String(clienteRow.ultimo_rol_mensaje) === '0') {
    const horasDiff =
      (Date.now() - new Date(clienteRow.ultimo_mensaje_at).getTime()) /
      (1000 * 60 * 60);
    return horasDiff < VENTANA_HORAS;
  }

  const [msgRow] = await db.query(
    `SELECT created_at FROM mensajes_clientes
     WHERE celular_recibe = ? AND id_configuracion = ? AND rol_mensaje = 0
     ORDER BY created_at DESC LIMIT 1`,
    {
      replacements: [clienteRow.id, id_configuracion],
      type: db.QueryTypes.SELECT,
    },
  );

  if (!msgRow?.created_at) return false;
  const horasDiff =
    (Date.now() - new Date(msgRow.created_at).getTime()) / (1000 * 60 * 60);
  return horasDiff < VENTANA_HORAS;
}

/* ═══════════════════════════════════════════════════════════
   Envío a Meta (WhatsApp Cloud API)
   ═══════════════════════════════════════════════════════════ */

function isWindowClosedError(err) {
  const c = err?.response?.data?.error?.code;
  const sc = err?.response?.data?.error?.error_subcode;
  return c === 131047 || sc === 131047 || c === 131026;
}

function isMetaRateLimit(err) {
  const s = err?.response?.status;
  const c = err?.response?.data?.error?.code;
  return s === 429 || c === 130429 || c === 80008;
}

async function enviarTemplate({
  phone_number_id,
  waba_token,
  phoneNorm,
  templateName,
  languageCode,
  components,
}) {
  const payload = {
    messaging_product: 'whatsapp',
    to: phoneNorm,
    type: 'template',
    template: { name: templateName, language: { code: languageCode || 'es' } },
  };
  if (components && components.length > 0)
    payload.template.components = components;
  const { data } = await axios.post(
    `https://graph.facebook.com/${META_API_VERSION}/${phone_number_id}/messages`,
    payload,
    {
      headers: {
        Authorization: `Bearer ${waba_token}`,
        'Content-Type': 'application/json',
      },
      timeout: 15000,
    },
  );
  return { wamid: data?.messages?.[0]?.id || null, payload };
}

async function enviarRespuestaRapida({
  phone_number_id,
  waba_token,
  phoneNorm,
  mensaje,
}) {
  const payload = {
    messaging_product: 'whatsapp',
    to: phoneNorm,
    type: 'text',
    text: { body: mensaje },
  };
  const { data } = await axios.post(
    `https://graph.facebook.com/${META_API_VERSION}/${phone_number_id}/messages`,
    payload,
    {
      headers: {
        Authorization: `Bearer ${waba_token}`,
        'Content-Type': 'application/json',
      },
      timeout: 15000,
    },
  );
  return { wamid: data?.messages?.[0]?.id || null, payload };
}

/* ═══════════════════════════════════════════════════════════
   Procesar templates para un lote de órdenes
   ═══════════════════════════════════════════════════════════ */

/**
 * Estados que se re-notifican si la guía cambió después de haberlos enviado.
 * El mensaje ya salió con un número que quedó obsoleto: quien vaya a la agencia
 * con él se topa con que "no existe". Reenviar es preferible a dejarlo mal.
 *
 * Solo aplica cuando la fila del reclamo ya tiene guía registrada. Las filas
 * anteriores a la migración la tienen en NULL: ahí no se sabe con qué número se
 * envió, y se rellena sin reenviar — si no, al desplegar esto se le reenviaría
 * la guía a todo el historial de golpe.
 */
const ESTADOS_RENOTIFICA_SI_CAMBIA_GUIA = new Set(['GUIA GENERADA']);

/**
 * ¿Está aplicada la migración que agrega shipping_guide?
 *
 * Las migraciones de este repo se corren a mano y el deploy es un push a main:
 * el código puede llegar a producción antes que el ALTER TABLE. Sin esta
 * comprobación, ese hueco dejaba el INSERT del reclamo con una columna
 * inexistente y tumbaba TODAS las notificaciones de Dropi, no solo la parte
 * nueva. Se resuelve una vez por proceso.
 */
let _colGuiaDisponible = null;
async function tieneColumnaGuia() {
  if (_colGuiaDisponible !== null) return _colGuiaDisponible;
  try {
    await db.query(
      `SELECT shipping_guide FROM dropi_plantillas_enviadas LIMIT 1`,
      { type: db.QueryTypes.SELECT },
    );
    _colGuiaDisponible = true;
  } catch (_) {
    _colGuiaDisponible = false;
    console.warn(
      '[dropi-notifier] dropi_plantillas_enviadas.shipping_guide no existe: ' +
        'falta correr dropi_plantillas_enviadas_guia_migration.sql. Los envíos ' +
        'siguen saliendo, pero no se detectan cambios de guía.',
    );
  }
  return _colGuiaDisponible;
}

/**
 * ¿Ya se envió este estado con OTRA guía? Devuelve true si se liberó el reclamo
 * para que se vuelva a enviar con la guía nueva.
 */
async function renotificarSiCambioGuia({
  dropi_order_id,
  id_configuracion,
  estado_dropi,
  shipping_guide,
}) {
  const guiaActual = String(shipping_guide || '').trim();
  if (!guiaActual) return false;
  if (!(await tieneColumnaGuia())) return false;

  const [row] = await db.query(
    `SELECT id, shipping_guide FROM dropi_plantillas_enviadas
      WHERE dropi_order_id = ? AND id_configuracion = ? AND estado_dropi = ?
      LIMIT 1`,
    {
      replacements: [dropi_order_id, id_configuracion, estado_dropi],
      type: db.QueryTypes.SELECT,
    },
  );
  if (!row) return false;

  const guiaEnviada = String(row.shipping_guide || '').trim();

  // Fila pre-migración: se completa el dato y NO se reenvía.
  if (!guiaEnviada) {
    await db.query(
      `UPDATE dropi_plantillas_enviadas SET shipping_guide = ? WHERE id = ?`,
      { replacements: [guiaActual, row.id], type: db.QueryTypes.UPDATE },
    );
    return false;
  }

  if (guiaEnviada === guiaActual) return false;

  // La guía cambió → se borra el reclamo para que el flujo normal vuelva a
  // reclamar y reenviar. El borrado y el reclamo son atómicos por separado; si
  // dos corridas coinciden, la segunda pierde el INSERT IGNORE y no duplica.
  await db.query(`DELETE FROM dropi_plantillas_enviadas WHERE id = ?`, {
    replacements: [row.id],
    type: db.QueryTypes.DELETE,
  });
  console.log(
    `[dropi-notifier] orden ${dropi_order_id} (cfg ${id_configuracion}): la guía cambió ${guiaEnviada} → ${guiaActual}, se reenvía "${estado_dropi}"`,
  );
  return true;
}

async function procesarTemplates({
  orders,
  id_configuracion,
  country_code = 'EC',
}) {
  if (!orders.length)
    return { enviados: 0, omitidos: 0, errores: 0, entregadas_actualizadas: 0 };

  // Corta-fuegos por plan: las notificaciones de estado son automatización.
  // Sin plan vigente no salen — ni por el cron ni por el webhook de Dropi,
  // que es el otro consumidor de esta función.
  const acceso = await verificarAccesoAutomatizaciones(id_configuracion);
  if (!acceso.permitido) {
    console.log(
      `[dropi-notifier] cfg ${id_configuracion}: automatizaciones cortadas (${acceso.motivo}), no se envían templates`,
    );
    return {
      enviados: 0,
      omitidos: orders.length,
      errores: 0,
      entregadas_actualizadas: 0,
    };
  }

  const plantillas = await getPlantillasActivas(id_configuracion);
  const creds = await getWaCredentials(id_configuracion);
  const credsValidas = !!(creds?.phone_number_id && creds?.waba_token);
  const telefonoConfig = creds?.telefono || null;

  const colDropiPrincipal = credsValidas
    ? await getColumnaPrincipalDropi(id_configuracion)
    : null;

  // Plantillas que realmente existen en la WABA de esta config (null = no se
  // pudo consultar → no se filtra nada).
  const aprobadas = credsValidas
    ? await getTemplatesAprobadas(creds.waba_id, creds.waba_token)
    : null;
  const faltantesAvisadas = new Set();

  let enviados = 0,
    omitidos = 0,
    errores = 0,
    entregadasActualizadas = 0;

  for (const order of orders) {
    try {
      const estadoConfig = mapDropiStatusToEstadoConfig(order.status);

      // Teléfono confiable de la orden (scoped a esta config). Si Dropi trae
      // un número incompleto y no se puede recuperar, telefonoOrden = null y
      // la orden se omite: mejor no enviar que enviarle a otra persona.
      const telefonoOrden = await resolverTelefonoConfiable({
        order,
        id_configuracion,
        country_code,
      });
      if (order.phone && !telefonoOrden) {
        console.log(
          `[dropi-notifier] tel incompleto no recuperable → skip orden ${order.id} (cfg ${id_configuracion}, tel "${order.phone}")`,
        );
      } else if (telefonoOrden && telefonoOrden !== order.phone) {
        console.log(
          `[dropi-notifier] tel recuperado para orden ${order.id} (cfg ${id_configuracion}): "${order.phone}" → "${telefonoOrden}"`,
        );
      }

      /* Un CANCELADO cuyo teléfono ya tiene una orden más nueva y viva no se
         procesa: ni plantilla ni movimiento de columna. Es la orden vieja que
         el equipo canceló para rehacerla — el chat sigue siendo una venta
         activa, no un cancelado (ver hayOrdenVivaPosterior). Vale para el
         cron horario Y para el webhook: los dos entran por esta función. */
      if (
        estadoConfig === 'CANCELADO' &&
        telefonoOrden &&
        (await hayOrdenVivaPosterior({
          id_configuracion,
          phone: telefonoOrden,
          dropi_order_id: order.id,
        }))
      ) {
        console.log(
          `[dropi-notifier] orden ${order.id} CANCELADA pero el teléfono tiene una orden más nueva viva → no se toca el chat (cfg ${id_configuracion})`,
        );
        omitidos++;
        continue;
      }

      if (estadoConfig === 'ENTREGADA' && telefonoOrden) {
        const columnaEntregada =
          plantillas[estadoConfig]?.columna_destino ||
          COLUMNA_ENTREGADA_DEFAULT;
        const actualizado = await actualizarEstadoContactoEntregado({
          id_configuracion,
          telefono: telefonoOrden,
          columnaDestino: columnaEntregada,
          country_code,
        });
        if (actualizado) entregadasActualizadas++;
        await moverContactoOrigenPorOrden({
          id_configuracion,
          dropi_order_id: order.id,
          columnaDestino: columnaEntregada,
        }).catch(() => {});
      }

      // ── SOLO MOVER DE COLUMNA (sin plantilla) ──
      // Estados que el cliente configuró únicamente para reubicar el contacto
      // en el kanban cuando Dropi notifica, SIN enviar ningún mensaje. No pasa
      // por el path de envío (ni WA creds, ni reclamo, ni template).
      const cfgEstado = estadoConfig ? plantillas[estadoConfig] : null;
      if (cfgEstado?.solo_mover) {
        // ENTREGADA ya se reubicó en el bloque de arriba; el resto se mueve aquí.
        if (estadoConfig !== 'ENTREGADA' && telefonoOrden) {
          await actualizarEstadoContactoEntregado({
            id_configuracion,
            telefono: telefonoOrden,
            columnaDestino: cfgEstado.columna_destino,
            country_code,
          });
          await moverContactoOrigenPorOrden({
            id_configuracion,
            dropi_order_id: order.id,
            columnaDestino: cfgEstado.columna_destino,
          }).catch(() => {});
        }
        omitidos++;
        continue;
      }

      if (!credsValidas) {
        omitidos++;
        continue;
      }
      if (!estadoConfig) {
        omitidos++;
        continue;
      }
      if (!plantillas[estadoConfig]) {
        omitidos++;
        continue;
      }
      if (!telefonoOrden) {
        omitidos++;
        continue;
      }

      // ¿Se envió este estado con una guía que Dropi ya reemplazó? Se libera
      // el reclamo ANTES del skip de abajo para que el flujo normal reenvíe
      // con el número bueno.
      if (ESTADOS_RENOTIFICA_SI_CAMBIA_GUIA.has(estadoConfig)) {
        await renotificarSiCambioGuia({
          dropi_order_id: order.id,
          id_configuracion,
          estado_dropi: estadoConfig,
          shipping_guide: order.shipping_guide,
        }).catch(() => false);
      }

      // Skip barato si ya se envió (evita armar payloads). La barrera REAL
      // contra duplicados es el reclamo atómico de más abajo.
      if (await yaFueEnviado(order.id, id_configuracion, estadoConfig)) {
        omitidos++;
        continue;
      }

      // Cross-system dedupe: si Shopify (u otra corrida) ya mandó, no duplicamos.
      // Se cruza por phone + total en 72h (cubre el desfase Shopify→Dropi).
      if (estadoConfig === 'PENDIENTE CONFIRMACION') {
        const yaShopify = await yaSeEnvioPendienteConfPorPhone(
          id_configuracion,
          telefonoOrden,
          country_code,
          order.total_order,
        );
        if (yaShopify) {
          omitidos++;
          continue;
        }
      }

      const config = plantillas[estadoConfig];
      const phoneNorm = normalizePhone(telefonoOrden, country_code);
      if (!phoneNorm) {
        omitidos++;
        continue;
      }

      // La plantilla configurada no existe en esta WABA (típico: se copió de
      // otra cuenta). Se omite ANTES de reclamar y de tocar el chat.
      if (
        aprobadas &&
        config.nombre_template &&
        !aprobadas.has(config.nombre_template)
      ) {
        if (!faltantesAvisadas.has(config.nombre_template)) {
          faltantesAvisadas.add(config.nombre_template);
          console.error(
            `[notifier] cfg ${id_configuracion}: la plantilla "${config.nombre_template}" (${estadoConfig}) no existe o no está aprobada en su WhatsApp. Se omiten esos envíos.`,
          );
        }
        omitidos++;
        continue;
      }

      // ── RECLAMO ANTES DE ENVIAR (atómico vía UNIQUE uk_order_config_estado).
      // Si otra corrida ya reclamó/envió → affectedRows=0 → no reenviamos.
      // Clave del fix: aunque fallen las escrituras DB POST-envío, el registro
      // anti-duplicado ya quedó y la orden nunca se reenvía.
      const reclamado = await reclamarEnvio({
        dropi_order_id: order.id,
        id_configuracion,
        estado_dropi: estadoConfig,
        phone: telefonoOrden,
        template_name: config.nombre_template,
        total: order.total_order,
        shipping_guide: order.shipping_guide,
      });
      if (!reclamado) {
        omitidos++;
        continue;
      }

      let clienteId = null;
      let idClienteConfig = null;
      let tipoEnvio = 'template';
      let waMessageId = null;
      let textoEnviado = config.nombre_template;
      let jsonMensajeEnviado = null;
      // Las variables del mensaje ({{telefono}}, ruta_archivo) también deben
      // llevar el número confiable, no el mocho que trae la orden.
      let orderParaMsg =
        telefonoOrden === order.phone
          ? order
          : { ...order, phone: telefonoOrden };

      /* RETIRO EN AGENCIA: `dir` es lo que el vendedor escribió al crear la
         orden. Cuando Servientrega no entregó a domicilio y dejó el paquete en
         una agencia, eso sigue siendo la CASA del cliente — y así salía en la
         plantilla ("retira en cdla. Héctor Cobos mz S villa 2…", cfg 889,
         orden 6612199). Dropi no manda la agencia; se resuelve aquí (tracking
         de Servientrega, con fallback) y se reemplaza `dir` para que la
         plantilla de estado, los recordatorios k1/k2/k3 y la ruta del chat
         hablen todos del mismo lugar. El domicilio queda en dir_domicilio.
         Va DESPUÉS del reclamo: solo se consulta cuando sí va a salir algo. */
      if (estadoConfig === 'RETIRO EN AGENCIA') {
        const retiro = await resolverLugarRetiro({
          order: orderParaMsg,
          country_code,
        });
        if (retiro?.lugar && retiro.lugar !== orderParaMsg.dir) {
          console.log(
            `[dropi-notifier] orden ${order.id} (cfg ${id_configuracion}) lugar de retiro ← ${retiro.fuente}: "${retiro.lugar}"` +
              (retiro.motivo ? ` (motivo: ${retiro.motivo})` : ''),
          );
          orderParaMsg = {
            ...orderParaMsg,
            dir_domicilio: orderParaMsg.dir,
            dir: retiro.lugar,
            agencia_retiro: retiro.agencia,
          };
        }
      }
      const components = buildTemplateComponents(
        config.parametros_json,
        orderParaMsg,
      );

      // ── BLOQUE DE ENVÍO. Si algo aquí falla, el mensaje NO salió:
      // liberamos el reclamo para reintentar en la próxima corrida.
      try {
        // Solo BUSCA: el contacto se crea después, si el mensaje sale.
        const resolved = await resolverClientes({
          id_configuracion,
          phoneNorm,
          phone_number_id: creds.phone_number_id,
          telefonoConfig,
          crearSiNoExiste: false,
        });
        clienteId = resolved.clienteId;
        idClienteConfig = resolved.idClienteConfig;

        const forzarTemplate = SIEMPRE_TEMPLATE.has(estadoConfig);

        if (
          !forzarTemplate &&
          config.usar_respuesta_rapida &&
          config.mensaje_rapido
        ) {
          const ventanaAbierta = await verificarVentana24h(
            id_configuracion,
            phoneNorm,
          );
          if (ventanaAbierta) {
            try {
              const result = await enviarRespuestaRapida({
                phone_number_id: creds.phone_number_id,
                waba_token: creds.waba_token,
                phoneNorm,
                mensaje: config.mensaje_rapido,
              });
              waMessageId = result.wamid;
              jsonMensajeEnviado = result.payload;
              tipoEnvio = 'respuesta_rapida';
              textoEnviado = config.mensaje_rapido;
            } catch (rrErr) {
              if (isWindowClosedError(rrErr)) {
                tipoEnvio = 'template';
              } else {
                throw rrErr;
              }
            }
          }
        }

        if (tipoEnvio === 'template') {
          const result = await enviarTemplate({
            phone_number_id: creds.phone_number_id,
            waba_token: creds.waba_token,
            phoneNorm,
            templateName: config.nombre_template,
            languageCode: config.language_code,
            components,
          });
          waMessageId = result.wamid;
          jsonMensajeEnviado = result.payload;
          const bodyInterpolado = interpolarBodyText(
            config.body_text,
            components,
          );
          textoEnviado = bodyInterpolado || config.nombre_template;
        }
      } catch (sendErr) {
        // El envío falló → liberar el reclamo para que reintente.
        await liberarEnvio({
          dropi_order_id: order.id,
          id_configuracion,
          estado_dropi: estadoConfig,
        });
        throw sendErr;
      }

      // ✅ A partir de aquí el mensaje YA SALIÓ. El reclamo se queda.
      // Todo lo siguiente es best-effort: si falla, NO se reenvía.

      // Recién ahora se crea el contacto del chat: hay un mensaje real que
      // lo justifica. Si el envío hubiera fallado, no queda nada.
      if (!clienteId) {
        try {
          const creado = await resolverClientes({
            id_configuracion,
            phoneNorm,
            phone_number_id: creds.phone_number_id,
            telefonoConfig,
          });
          clienteId = creado.clienteId;
          idClienteConfig = idClienteConfig || creado.idClienteConfig;
        } catch (_) {}
      }

      const rutaArchivo = buildRutaArchivo(orderParaMsg, estadoConfig);

      let columnaDestino = null;
      if (estadoConfig === 'PENDIENTE CONFIRMACION') {
        columnaDestino = colDropiPrincipal?.estado_db || null;
      } else if (estadoConfig === 'ENTREGADA') {
        columnaDestino = config.columna_destino || COLUMNA_ENTREGADA_DEFAULT;
      } else if (config.columna_destino) {
        columnaDestino = config.columna_destino;
      }

      if (columnaDestino && clienteId) {
        try {
          await db.query(
            `UPDATE clientes_chat_center
             SET estado_contacto = ?
             WHERE id = ? AND id_configuracion = ?`,
            {
              replacements: [columnaDestino, clienteId, id_configuracion],
              type: db.QueryTypes.UPDATE,
            },
          );
        } catch (err) {}

        // Mueve TAMBIÉN al contacto origen enlazado (silencioso), si la orden se
        // creó desde nuestro sistema con otro teléfono.
        await moverContactoOrigenPorOrden({
          id_configuracion,
          dropi_order_id: order.id,
          columnaDestino,
        }).catch(() => {});

        // ── Seguimiento automático tras el movimiento de columna ──
        // El motor de secuencias (configuracion_remarketing) ya existía pero
        // solo lo agendaba el bot al responder; un contacto movido por el
        // notifier nunca entraba. Caso que lo motiva: RETIRO EN AGENCIA — la
        // orden queda esperando a que la persona vaya a la agencia y, si no
        // va, termina en devolución.
        //
        // Alcance deliberadamente corto: el notifier mueve a 9 columnas
        // distintas y varias tienen secuencias cargadas de otras épocas
        // (generar_guia, novedad, guia_creada). Agendar en todas encendería
        // envíos en cuentas que nunca lo pidieron. Se amplía agregando a esta
        // lista, no por accidente.
        if (COLUMNAS_CON_SEGUIMIENTO.has(columnaDestino)) {
          await programarSeguimientoColumna({
            id_configuracion,
            id_cliente: clienteId,
            telefono: phoneNorm,
            estado_contacto: columnaDestino,
            // Datos del pedido resueltos AQUÍ, que es donde están a la vista.
            // El cron dispara 24h después y ya no tiene la orden; por eso los
            // recordatorios los reciben ya listos. Orden = {{1}}..{{4}} de las
            // plantillas retiro_agencia_recordatorio_k1/k2/k3.
            template_parameters: await construirParamsRetiroAgencia({
              id_configuracion,
              order: orderParaMsg,
            }),
          });
        }
      }

      try {
        await registrarMensajeEnChat({
          id_configuracion,
          phone_number_id: creds.phone_number_id,
          clienteId,
          idClienteConfig,
          phoneNorm,
          tipoEnvio,
          textoMensaje: textoEnviado,
          templateName:
            tipoEnvio === 'template' ? config.nombre_template : null,
          languageCode: config.language_code,
          waMessageId,
          rutaArchivo,
          jsonMensaje: jsonMensajeEnviado,
        });
      } catch (err) {}

      // Completa wa_message_id/template_name del reclamo (best-effort).
      try {
        await completarEnvio({
          dropi_order_id: order.id,
          id_configuracion,
          estado_dropi: estadoConfig,
          template_name:
            tipoEnvio === 'respuesta_rapida'
              ? `[RR] ${config.mensaje_rapido.slice(0, 80)}`
              : config.nombre_template,
          wa_message_id: waMessageId,
        });
      } catch (err) {}

      enviados++;
      await new Promise((r) => setTimeout(r, DELAY_BETWEEN_WA_SENDS));
    } catch (err) {
      errores++;
      // Sin este log era imposible saber POR QUÉ una orden nunca envió:
      // el reclamo se libera al fallar y no queda rastro en la BD.
      const metaErr = err?.response?.data?.error;
      console.error(
        `[dropi-notifier] fallo envío orden ${order.id} (cfg ${id_configuracion}, estado "${order.status}"):`,
        metaErr
          ? `code=${metaErr.code} subcode=${metaErr.error_subcode || '-'} ${metaErr.message}`
          : err.message,
      );
      if (isMetaRateLimit(err)) await new Promise((r) => setTimeout(r, 30000));
    }
  }

  return {
    enviados,
    omitidos,
    errores,
    entregadas_actualizadas: entregadasActualizadas,
  };
}

module.exports = {
  // clasificación / mapeo
  mapDropiStatusToEstadoConfig,
  classifyDropiStatus,
  // helpers
  normalizePhone,
  resolverTelefonoConfiable,
  safeJsonParse,
  getTrackingUrl,
  getGuiaPdfUrl,
  reconstructGuiaPdfPath,
  resolveVariable,
  buildTemplateComponents,
  buildRutaArchivo,
  interpolarBodyText,
  // piezas reutilizables por otros orígenes de seguimiento
  // (services/seguimiento_plantillas.service.js). Se exportan para NO volver a
  // duplicar el envío/registro como pasó con el webhook de Shopify.
  getWaCredentials,
  resolverClientes,
  registrarMensajeEnChat,
  enviarTemplate,
  // Piezas que consume services/aliclik_notifier.service.js. Aliclik identifica
  // sus pedidos con un string (orderNumber), no con un id numérico, así que no
  // puede reusar procesarTemplates() —que está atada a dropi_order_id BIGINT—
  // y arma su propio bucle con estas mismas hojas. Se exportan en vez de
  // duplicarlas: la lógica de ventana de 24h, plantillas aprobadas y kanban
  // debe vivir en un solo lugar.
  getTemplatesAprobadas,
  verificarVentana24h,
  enviarRespuestaRapida,
  getColumnaPrincipalDropi,
  actualizarEstadoContactoEntregado,
  isWindowClosedError,
  isMetaRateLimit,
  // detección de guía reemplazada por Dropi
  renotificarSiCambioGuia,
  // persistencia / envío
  upsertOrders,
  getPlantillasActivas,
  procesarTemplates,
};
