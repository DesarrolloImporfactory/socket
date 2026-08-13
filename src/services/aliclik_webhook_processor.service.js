'use strict';

/**
 * services/aliclik_webhook_processor.service.js
 *
 * Procesamiento en tiempo real de los eventos del webhook de Aliclik
 * (POST /api/v1/aliclik_webhook/orders/:secret → aliclik_webhook.controller).
 *
 * El payload de Aliclik trae SOLO { orderNumber, callStatus, status,
 * dispatchStatus }: ni teléfono, ni productos, ni total. Todo lo que hace falta
 * para notificar sale de otro lado:
 *   1. del cache local (aliclik_orders_cache), que es el camino normal;
 *   2. si el pedido no está cacheado, de GET /integration/order — una llamada
 *      por evento, solo la primera vez que se ve ese pedido.
 *
 * Los estados nuevos del evento siempre pisan a los del cache: son la novedad
 * que Aliclik está notificando.
 *
 * Cola FIFO en memoria con concurrencia 1, igual que la de Dropi: se responde
 * 200 de inmediato y el trabajo pesado (llamada a la API + envío a Meta) queda
 * fuera del ciclo de request. Si el proceso se reinicia con eventos en cola, el
 * cron syncAliclikOrders los recupera en la corrida siguiente.
 */

const { decryptToken } = require('../utils/cryptoToken');
const aliclikService = require('./aliclik.service');
const {
  normalizarOrden,
  upsertOrders,
  getOrdenDeCache,
  procesarTemplates,
} = require('./aliclik_notifier.service');

const MAX_QUEUE = 5000;

/* ═══════════════════════════════════════════════════════════
   Procesar UN evento
   ═══════════════════════════════════════════════════════════ */

/**
 * @param {object} evento
 * @param {object} evento.payload      body crudo del webhook
 * @param {object} evento.integracion  fila de aliclik_integrations
 */
async function processOne({ payload, integracion }) {
  const orderNumber = String(payload?.orderNumber || '').trim();
  if (!orderNumber) return;

  const id_configuracion = Number(integracion.id_configuracion);
  if (!id_configuracion) return;

  // 1) Base: lo que ya sabemos del pedido
  let orden = await getOrdenDeCache(orderNumber, id_configuracion);

  // 2) Sin cache (o cacheado sin teléfono, que es lo único que no podemos
  //    inventar) → traerlo de la API. Es la única llamada de red del flujo.
  if (!orden || !orden.phone) {
    try {
      const token = decryptToken(integracion.token_enc);
      const remoto = await aliclikService.getOrderByNumber({
        token,
        orderNumber,
      });
      if (remoto) orden = normalizarOrden(remoto);
    } catch (err) {
      console.log(
        `[AliclikWebhook RT] no se pudo traer la orden ${orderNumber} (cfg ${id_configuracion}): ${err?.message || err}`,
      );
    }
  }

  if (!orden) {
    // El pedido no existe para esta integración: el evento ya quedó
    // persistido en aliclik_webhook_events para diagnóstico.
    console.log(
      `[AliclikWebhook RT] orden ${orderNumber} no encontrada (cfg ${id_configuracion}), evento ignorado`,
    );
    return;
  }

  // 3) Los estados del evento mandan: son la novedad que Aliclik notifica.
  orden = {
    ...orden,
    order_number: orderNumber,
    id: orden.id || orderNumber,
    call_status: payload.callStatus ?? orden.call_status,
    status_entrega: payload.status ?? orden.status_entrega,
    dispatch_status: payload.dispatchStatus ?? orden.dispatch_status,
  };

  // 4) Persistir + notificar
  try {
    await upsertOrders(id_configuracion, [orden]);
    const stats = await procesarTemplates({
      ordenes: [orden],
      id_configuracion,
    });
    if (stats?.enviados > 0) {
      console.log(
        `[AliclikWebhook RT] orden ${orderNumber} (${orden.dispatch_status}/${orden.status_entrega}) → ${stats.enviados} mensaje(s) enviados en tiempo real`,
      );
    }
  } catch (err) {
    console.log(
      `[AliclikWebhook RT] error procesando orden ${orderNumber} (cfg ${id_configuracion}): ${err?.message || err}`,
    );
  }
}

/* ═══════════════════════════════════════════════════════════
   Cola FIFO en memoria
   ═══════════════════════════════════════════════════════════ */

const queue = [];
let draining = false;

async function drain() {
  draining = true;
  while (queue.length > 0) {
    const evento = queue.shift();
    try {
      await processOne(evento);
    } catch (err) {
      console.log(
        `[AliclikWebhook RT] error procesando evento ${evento?.payload?.orderNumber}: ${err?.message || err}`,
      );
    }
  }
  draining = false;
}

/**
 * Encola un evento del webhook. Fire-and-forget: el controller ya respondió.
 */
function encolarEventoWebhook(evento) {
  if (queue.length >= MAX_QUEUE) {
    console.log(
      `[AliclikWebhook RT] cola llena (${MAX_QUEUE}), evento ${evento?.payload?.orderNumber} descartado (el cron lo cubrirá)`,
    );
    return;
  }
  queue.push(evento);
  if (!draining) {
    drain().catch(() => {
      draining = false;
    });
  }
}

module.exports = { encolarEventoWebhook, processOne };
