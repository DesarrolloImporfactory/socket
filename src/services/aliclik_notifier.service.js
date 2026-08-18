'use strict';

/**
 * services/aliclik_notifier.service.js
 *
 * Traduce los pedidos de Aliclik al mismo vocabulario de estados que ya usa
 * el notifier de Dropi y dispara las plantillas de WhatsApp correspondientes.
 *
 * ── Por qué no reusa procesarTemplates() de dropi_notifier ──────────────────
 * Ese bucle está atado a `dropi_order_id BIGINT` en tres puntos: el reclamo
 * atómico anti-duplicados, el chequeo previo y el completado del envío.
 * Aliclik identifica sus pedidos con un STRING (orderNumber, "ALC000123456789")
 * que no entra en esa columna. Reescribir la firma de procesarTemplates para
 * que acepte ambos tipos implicaba tocar el camino que hoy factura todo, sin
 * suite de pruebas que lo respalde.
 *
 * La decisión fue duplicar SOLO el bucle (que es orquestación) y reusar todas
 * las hojas, que son las que concentran el conocimiento delicado: ventana de
 * 24h, plantillas aprobadas en la WABA, resolución de contactos, registro en el
 * chat, movimiento de columna del kanban y envío a Meta. Esas se importan de
 * dropi_notifier.service — no se copian.
 *
 * ── Diferencias de modelo respecto a Dropi ──────────────────────────────────
 *  · El estado no es un campo sino tres (callStatus / status / dispatchStatus).
 *  · No existe número de guía ni PDF en ningún endpoint de Aliclik, así que no
 *    hay estado "GUIA GENERADA" ni variables de tracking.
 *  · La entrega es siempre en Perú, pero el TELÉFONO puede ser de cualquier
 *    país: lo que define el destino son las coordenadas del pedido, no el
 *    número. COUNTRY_CODE = 'PE' es solo la región por defecto para
 *    interpretar números escritos en formato nacional.
 */

const { db } = require('../database/config');
const AliclikOrdersCache = require('../models/aliclik_orders_cache.model');
const { verificarAccesoAutomatizaciones } = require('../utils/planAcceso');
const { toE164Multipais } = require('../utils/phoneFactor');

const {
  normalizePhone,
  buildTemplateComponents,
  buildRutaArchivo,
  interpolarBodyText,
  getWaCredentials,
  getPlantillasActivas,
  getTemplatesAprobadas,
  getColumnaPrincipalDropi,
  actualizarEstadoContactoEntregado,
  resolverClientes,
  registrarMensajeEnChat,
  verificarVentana24h,
  enviarTemplate,
  enviarRespuestaRapida,
  isWindowClosedError,
  isMetaRateLimit,
} = require('./dropi_notifier.service');

const PROVEEDOR = 'aliclik';
const COUNTRY_CODE = 'PE';
const DELAY_BETWEEN_WA_SENDS = 800;
const COLUMNA_ENTREGADA_DEFAULT = 'entregada';

// PENDIENTE CONFIRMACION siempre sale como plantilla aunque la ventana de 24h
// esté abierta: es el primer contacto y debe ser un mensaje formal.
const SIEMPRE_TEMPLATE = new Set(['PENDIENTE CONFIRMACION']);

/**
 * Estados canónicos que Aliclik puede alcanzar. Es un subconjunto de los de
 * Dropi: faltan 'GUIA GENERADA' (Aliclik no expone guías) y
 * 'CARRITOS ABANDONADOS' (no tiene ese concepto).
 */
const ESTADOS_ALICLIK = [
  'PENDIENTE CONFIRMACION',
  'PENDIENTE',
  'EN TRANSITO',
  'RETIRO EN AGENCIA',
  'ENTREGADA',
  'NOVEDAD',
  'DEVOLUCION',
  'CANCELADO',
];

/* ═══════════════════════════════════════════════════════════
   Mapeo: tripleta de Aliclik → estado canónico
   ═══════════════════════════════════════════════════════════ */

/**
 * Colapsa los tres ejes de estado de Aliclik en un único estado canónico.
 *
 * El orden de las reglas importa: se evalúan primero los estados terminales
 * (entregado, cancelado, devuelto) porque conviven con valores de despacho que
 * si se leyeran solos darían un estado anterior del ciclo. Ejemplo real de la
 * tabla de su doc: un pedido entregado llega como
 * dispatchStatus=PICKED + status=DELIVERED — si se mirara PICKED primero se
 * anunciaría "en camino" a alguien que ya recibió el paquete.
 *
 * Devuelve null cuando la combinación no corresponde a ningún estado
 * notificable (igual que mapDropiStatusToEstadoConfig): el evento se guarda
 * pero no dispara mensaje.
 */
function mapAliclikStatusToEstadoConfig({
  callStatus,
  status,
  dispatchStatus,
} = {}) {
  const call = String(callStatus || '').trim().toUpperCase();
  const st = String(status || '').trim().toUpperCase();
  const disp = String(dispatchStatus || '').trim().toUpperCase();

  // 1) Terminales de entrega
  if (st === 'DELIVERED') return 'ENTREGADA';

  // 2) Anulaciones / cancelaciones (por cualquiera de los dos ejes)
  if (st === 'CANCEL' || st === 'ANNULLED' || call === 'ANNULLED')
    return 'CANCELADO';

  // 3) Retorno al almacén. Se evalúa antes que tránsito porque
  //    REMAINING_IN_TRANSIT / STORE_CENTRAL son etapas de la devolución.
  if (
    disp === 'TO_RETURN' ||
    disp === 'RETURNED' ||
    disp === 'LEFT_IN_WAREHOUSE' ||
    disp === 'STORE_CENTRAL'
  )
    return 'DEVOLUCION';

  // 4) Incidencias en la entrega: el paquete sigue vivo pero algo pasó.
  if (st === 'REFUSED' || st === 'NOT_RESPOND' || st === 'RESCHEDULED')
    return 'NOVEDAD';

  // 5) Disponible para recojo en agencia
  if (disp === 'IN_AGENCY') return 'RETIRO EN AGENCIA';

  // 6) En movimiento. PICKED sin DELIVERED (ya descartado arriba) significa
  //    que el courier lo validó y salió.
  if (
    disp === 'IN_TRANSIT' ||
    disp === 'REMAINING_IN_TRANSIT' ||
    disp === 'PICKED'
  )
    return 'EN TRANSITO';

  // 7) Todavía en almacén: la llamada de confirmación decide cuál de los dos.
  if (disp === 'TO_PREPARE' || disp === 'PREPARED') {
    return call === 'CONFIRMED' ? 'PENDIENTE' : 'PENDIENTE CONFIRMACION';
  }

  // Sin despacho conocido, la confirmación pendiente sigue siendo notificable.
  if (call && call !== 'CONFIRMED' && st === 'PENDING_DELIVERY')
    return 'PENDIENTE CONFIRMACION';

  return null;
}

/* ═══════════════════════════════════════════════════════════
   Normalización: pedido Aliclik → forma que entienden los helpers
   ═══════════════════════════════════════════════════════════ */

/**
 * Convierte un pedido de Aliclik a la forma de orden que ya consumen
 * resolveVariable / buildTemplateComponents / buildRutaArchivo, para no tener
 * dos implementaciones de las variables de plantilla.
 *
 * Los campos sin equivalente (shipping_guide, shipping_company) quedan sin
 * definir a propósito: getTrackingUrl y getGuiaPdfUrl ya devuelven '' cuando
 * faltan, así que una plantilla mal configurada con {{tracking}} degrada a
 * vacío en vez de romper el envío.
 */
function normalizarOrden(o) {
  const shipping = o?.shipping || {};
  const customer = o?.customer || {};

  const dir = [shipping.address1, shipping.address2]
    .map((v) => String(v || '').trim())
    .filter(Boolean)
    .join(', ');

  return {
    // `id` alimenta la variable {{order_id}}; acá es el string de Aliclik.
    id: o?.orderNumber || null,
    order_number: o?.orderNumber || null,

    call_status: o?.callStatus || null,
    status_entrega: o?.status || null,
    dispatch_status: o?.dispatchStatus || null,

    name: customer.name || null,
    surname: customer.lastName || null,
    phone: customer.phone || null,
    email: customer.email || null,

    dir: dir || null,
    city: shipping.districtName || null,
    state: shipping.departmentName || null,
    lat: shipping.lat || null,
    lng: shipping.lng || null,
    reference: shipping.reference || null,

    total_order: o?.total ?? 0,
    channel: o?.channel || null,
    notes: o?.note || null,

    // Aliclik no devuelve el nombre del producto por item (solo skuId), pero sí
    // un resumen textual en productDetail. resolveVariable('contenido') lo
    // prefiere cuando existe.
    contenido_texto: o?.productDetail || null,
    orderdetails: [],

    created_at: o?.createdAt || null,
    updated_at: o?.updatedAt || null,
  };
}

/* ═══════════════════════════════════════════════════════════
   Cache local
   ═══════════════════════════════════════════════════════════ */

/** "2026-04-22T15:30:12.000Z" → "2026-04-22 15:30:12" (MySQL-safe). */
function normalizeFecha(value) {
  if (!value || typeof value !== 'string') return value || null;
  return value.replace('T', ' ').replace(/(\.\d+)?Z?$/, '');
}

async function upsertOrders(id_configuracion, ordenes) {
  if (!ordenes.length) return;

  const bulk = ordenes.map((o) => ({
    order_number: o.order_number,
    id_configuracion,
    call_status: o.call_status || null,
    status: o.status_entrega || null,
    dispatch_status: o.dispatch_status || null,
    estado_config: mapAliclikStatusToEstadoConfig({
      callStatus: o.call_status,
      status: o.status_entrega,
      dispatchStatus: o.dispatch_status,
    }),
    total: Number(o.total_order || 0),
    name: o.name || null,
    surname: o.surname || null,
    phone: o.phone || null,
    city: o.city || null,
    state: o.state || null,
    product_detail: o.contenido_texto || null,
    order_created_at: normalizeFecha(o.created_at),
    order_data: JSON.stringify(o),
    synced_at: new Date(),
  }));

  for (let i = 0; i < bulk.length; i += 200) {
    await AliclikOrdersCache.bulkCreate(bulk.slice(i, i + 200), {
      updateOnDuplicate: [
        'call_status',
        'status',
        'dispatch_status',
        'estado_config',
        'total',
        'name',
        'surname',
        'phone',
        'city',
        'state',
        'product_detail',
        'order_data',
        'synced_at',
      ],
    });
  }
}

/** Devuelve la orden normalizada guardada en cache, o null. */
async function getOrdenDeCache(order_number, id_configuracion) {
  const [row] = await db.query(
    `SELECT order_data FROM aliclik_orders_cache
      WHERE order_number = ? AND id_configuracion = ? LIMIT 1`,
    {
      replacements: [order_number, id_configuracion],
      type: db.QueryTypes.SELECT,
    },
  );
  if (!row?.order_data) return null;
  try {
    return JSON.parse(row.order_data);
  } catch (_) {
    return null;
  }
}

/* ═══════════════════════════════════════════════════════════
   Dedupe de envíos (aliclik_plantillas_enviadas)
   ═══════════════════════════════════════════════════════════ */

async function yaFueEnviado(order_number, id_configuracion, estado) {
  const [row] = await db.query(
    `SELECT id FROM aliclik_plantillas_enviadas
      WHERE order_number = ? AND id_configuracion = ? AND estado = ? LIMIT 1`,
    {
      replacements: [order_number, id_configuracion, estado],
      type: db.QueryTypes.SELECT,
    },
  );
  return !!row;
}

/**
 * Reclama el envío ANTES de mandar el mensaje. Atómico gracias al UNIQUE
 * uk_aliclik_order_config_estado. Devuelve true si esta corrida ganó el
 * derecho a enviar; false si otra ya lo reclamó (webhook vs cron).
 */
async function reclamarEnvio({
  order_number,
  id_configuracion,
  estado,
  phone,
  template_name,
  total = null,
}) {
  const [res] = await db.query(
    `INSERT IGNORE INTO aliclik_plantillas_enviadas
       (order_number, id_configuracion, estado, phone, template_name, total)
     VALUES (?, ?, ?, ?, ?, ?)`,
    {
      replacements: [
        order_number,
        id_configuracion,
        estado,
        phone || null,
        template_name || null,
        Number(total) || null,
      ],
    },
  );
  return Number(res?.affectedRows || 0) === 1;
}

/** Libera el reclamo SOLO si el envío a Meta falló, para reintentar luego. */
async function liberarEnvio({ order_number, id_configuracion, estado }) {
  await db.query(
    `DELETE FROM aliclik_plantillas_enviadas
      WHERE order_number = ? AND id_configuracion = ? AND estado = ?`,
    {
      replacements: [order_number, id_configuracion, estado],
      type: db.QueryTypes.DELETE,
    },
  );
}

async function completarEnvio({
  order_number,
  id_configuracion,
  estado,
  template_name,
  wa_message_id,
}) {
  await db.query(
    `UPDATE aliclik_plantillas_enviadas
        SET wa_message_id = ?, template_name = ?
      WHERE order_number = ? AND id_configuracion = ? AND estado = ?`,
    {
      replacements: [
        wa_message_id || null,
        template_name || null,
        order_number,
        id_configuracion,
        estado,
      ],
      type: db.QueryTypes.UPDATE,
    },
  );
}

/* ═══════════════════════════════════════════════════════════
   Procesar templates para un lote de órdenes
   ═══════════════════════════════════════════════════════════ */

/**
 * @param {object[]} ordenes  órdenes YA normalizadas (ver normalizarOrden)
 */
async function procesarTemplates({ ordenes, id_configuracion }) {
  if (!ordenes.length)
    return { enviados: 0, omitidos: 0, errores: 0, entregadas_actualizadas: 0 };

  // Corta-fuegos por plan: las notificaciones de estado son automatización.
  // Sin plan vigente no salen, ni por webhook ni por cron.
  const acceso = await verificarAccesoAutomatizaciones(id_configuracion);
  if (!acceso.permitido) {
    console.log(
      `[aliclik-notifier] cfg ${id_configuracion}: automatizaciones cortadas (${acceso.motivo}), no se envían templates`,
    );
    return {
      enviados: 0,
      omitidos: ordenes.length,
      errores: 0,
      entregadas_actualizadas: 0,
    };
  }

  const plantillas = await getPlantillasActivas(id_configuracion, PROVEEDOR);
  const creds = await getWaCredentials(id_configuracion);
  const credsValidas = !!(creds?.phone_number_id && creds?.waba_token);
  const telefonoConfig = creds?.telefono || null;

  const colPrincipal = credsValidas
    ? await getColumnaPrincipalDropi(id_configuracion)
    : null;

  // Plantillas que realmente existen en la WABA (null = no se pudo consultar).
  const aprobadas = credsValidas
    ? await getTemplatesAprobadas(creds.waba_id, creds.waba_token)
    : null;
  const faltantesAvisadas = new Set();

  let enviados = 0,
    omitidos = 0,
    errores = 0,
    entregadasActualizadas = 0;

  for (const order of ordenes) {
    try {
      const estadoConfig = mapAliclikStatusToEstadoConfig({
        callStatus: order.call_status,
        status: order.status_entrega,
        dispatchStatus: order.dispatch_status,
      });

      // Aliclik entrega el teléfono completo y con código de país
      // ("51918993266"), así que no hace falta la recuperación de números
      // mochos que sí necesita Dropi. Igual se valida: un número incompleto
      // matchearía por sufijo al contacto de otra persona.
      //
      // Se acepta cualquier país soportado, no solo Perú: Aliclik permite
      // pedidos con teléfono extranjero (lo que define la entrega son las
      // coordenadas) y ese cliente tiene que recibir su seguimiento igual.
      // Exigir región PE lo dejaría sin ninguna notificación, en silencio.
      const telefonoOrden = order.phone
        ? toE164Multipais(order.phone, COUNTRY_CODE)
        : null;
      if (order.phone && !telefonoOrden) {
        console.log(
          `[aliclik-notifier] tel inválido → skip orden ${order.order_number} (cfg ${id_configuracion}, tel "${order.phone}")`,
        );
      }

      if (estadoConfig === 'ENTREGADA' && telefonoOrden) {
        const columnaEntregada =
          plantillas[estadoConfig]?.columna_destino || COLUMNA_ENTREGADA_DEFAULT;
        const actualizado = await actualizarEstadoContactoEntregado({
          id_configuracion,
          telefono: telefonoOrden,
          columnaDestino: columnaEntregada,
          country_code: COUNTRY_CODE,
        });
        if (actualizado) entregadasActualizadas++;
      }

      // ── SOLO MOVER DE COLUMNA (sin plantilla) ──
      const cfgEstado = estadoConfig ? plantillas[estadoConfig] : null;
      if (cfgEstado?.solo_mover) {
        if (estadoConfig !== 'ENTREGADA' && telefonoOrden) {
          await actualizarEstadoContactoEntregado({
            id_configuracion,
            telefono: telefonoOrden,
            columnaDestino: cfgEstado.columna_destino,
            country_code: COUNTRY_CODE,
          });
        }
        omitidos++;
        continue;
      }

      if (!credsValidas || !estadoConfig || !plantillas[estadoConfig]) {
        omitidos++;
        continue;
      }
      if (!telefonoOrden) {
        omitidos++;
        continue;
      }

      // Skip barato si ya se envió. La barrera REAL es el reclamo atómico.
      if (
        await yaFueEnviado(order.order_number, id_configuracion, estadoConfig)
      ) {
        omitidos++;
        continue;
      }

      const config = plantillas[estadoConfig];
      // telefonoOrden ya viene en E.164 desde toE164Multipais; normalizePhone
      // queda como red de seguridad y para no divergir del camino de Dropi.
      const phoneNorm = normalizePhone(telefonoOrden, COUNTRY_CODE);
      if (!phoneNorm) {
        omitidos++;
        continue;
      }

      // La plantilla configurada no existe en esta WABA (típico: copiada de
      // otra cuenta). Se omite ANTES de reclamar y de tocar el chat.
      if (
        aprobadas &&
        config.nombre_template &&
        !aprobadas.has(config.nombre_template)
      ) {
        if (!faltantesAvisadas.has(config.nombre_template)) {
          faltantesAvisadas.add(config.nombre_template);
          console.error(
            `[aliclik-notifier] cfg ${id_configuracion}: la plantilla "${config.nombre_template}" (${estadoConfig}) no existe o no está aprobada en su WhatsApp. Se omiten esos envíos.`,
          );
        }
        omitidos++;
        continue;
      }

      // ── RECLAMO ANTES DE ENVIAR (atómico vía UNIQUE) ──
      const reclamado = await reclamarEnvio({
        order_number: order.order_number,
        id_configuracion,
        estado: estadoConfig,
        phone: telefonoOrden,
        template_name: config.nombre_template,
        total: order.total_order,
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
      const components = buildTemplateComponents(config.parametros_json, order);

      // ── BLOQUE DE ENVÍO. Si algo falla acá el mensaje NO salió:
      // se libera el reclamo para reintentar en la próxima corrida.
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
        await liberarEnvio({
          order_number: order.order_number,
          id_configuracion,
          estado: estadoConfig,
        });
        throw sendErr;
      }

      // ✅ A partir de acá el mensaje YA SALIÓ. El reclamo se queda.
      // Todo lo que sigue es best-effort: si falla, NO se reenvía.

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

      const rutaArchivo = buildRutaArchivo(order, estadoConfig);

      let columnaDestino = null;
      if (estadoConfig === 'PENDIENTE CONFIRMACION') {
        columnaDestino = colPrincipal?.estado_db || null;
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
        } catch (_) {}
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
          templateName: tipoEnvio === 'template' ? config.nombre_template : null,
          languageCode: config.language_code,
          waMessageId,
          rutaArchivo,
          jsonMensaje: jsonMensajeEnviado,
          responsable: 'Aliclik Status',
        });
      } catch (_) {}

      try {
        await completarEnvio({
          order_number: order.order_number,
          id_configuracion,
          estado: estadoConfig,
          template_name:
            tipoEnvio === 'respuesta_rapida'
              ? `[RR] ${config.mensaje_rapido.slice(0, 80)}`
              : config.nombre_template,
          wa_message_id: waMessageId,
        });
      } catch (_) {}

      enviados++;
      await new Promise((r) => setTimeout(r, DELAY_BETWEEN_WA_SENDS));
    } catch (err) {
      errores++;
      const metaErr = err?.response?.data?.error;
      console.error(
        `[aliclik-notifier] fallo envío orden ${order.order_number} (cfg ${id_configuracion}, estado call=${order.call_status} st=${order.status_entrega} disp=${order.dispatch_status}):`,
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
  PROVEEDOR,
  COUNTRY_CODE,
  ESTADOS_ALICLIK,
  mapAliclikStatusToEstadoConfig,
  normalizarOrden,
  normalizeFecha,
  upsertOrders,
  getOrdenDeCache,
  procesarTemplates,
  // exportados para pruebas / diagnóstico
  reclamarEnvio,
  liberarEnvio,
  yaFueEnviado,
};
