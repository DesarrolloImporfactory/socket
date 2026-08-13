'use strict';

/**
 * services/seguimiento_plantillas.service.js
 *
 * PLANTILLAS DE SEGUIMIENTO — punto único (multiplataforma).
 *
 * Los estados de seguimiento (PENDIENTE CONFIRMACION, GUIA GENERADA, EN
 * TRANSITO…) se configuran en `dropi_plantillas_config` y hoy se disparan
 * desde tres orígenes:
 *
 *   1. Dropi        → cron/webhook  (services/dropi_notifier.service.js)
 *   2. Shopify      → webhook       (utils/shopify/enviarPendienteConfirmacionShopify.js)
 *   3. Bot WhatsApp → este service  (services/dropiAutoOrder.service.js)
 *
 * Este archivo cubre el origen 3 y es el lugar donde deben entrar las
 * plataformas que vengan (TikTok Shop, WooCommerce…): la config de plantillas
 * es la misma, lo único que cambia es de dónde nace la orden. Los helpers de
 * envío/registro se reutilizan del notifier (no se vuelve a duplicar el código
 * como ocurrió con Shopify).
 *
 * DIFERENCIA CLAVE del origen "bot":
 *  - Dropi/Shopify: el pedido entra frío → el contacto se MUEVE a la columna
 *    principal de Dropi (pendiente_confirmacion) y ahí confirma.
 *  - Bot WhatsApp: la venta ya la cerró el bot en la conversación → el
 *    contacto SE QUEDA en `generar_guia`. Solo se le manda la plantilla de
 *    confirmación; no se le devuelve a una columna anterior.
 *
 * GATE por cliente: `dropi_plantillas_config.enviar_en_orden_bot`. Viene
 * encendido, pero el cliente que no quiera doble confirmación lo apaga desde
 * "Plantillas de seguimiento" y el bot deja de mandarla.
 */

const { db } = require('../database/config');
const {
  normalizePhone,
  buildTemplateComponents,
  buildRutaArchivo,
  interpolarBodyText,
  getWaCredentials,
  resolverClientes,
  registrarMensajeEnChat,
  enviarTemplate,
} = require('./dropi_notifier.service');

const ESTADO = 'PENDIENTE CONFIRMACION';
const SOURCE_BOT = 'bot_whatsapp';
const SOURCE_BLOQUEO = 'sistema_local';

/* ═══════════════════════════════════════════════════════════
   Config del estado
   ═══════════════════════════════════════════════════════════ */

async function getConfigPendienteConfirmacion(id_configuracion) {
  const [row] = await db.query(
    `SELECT nombre_template, language_code, parametros_json, body_text,
            activo, enviar_en_orden_bot
     FROM dropi_plantillas_config
     WHERE id_configuracion = ? AND proveedor = 'dropi' AND estado_dropi = ?
     LIMIT 1`,
    {
      replacements: [id_configuracion, ESTADO],
      type: db.QueryTypes.SELECT,
    },
  );
  return row || null;
}

/* ═══════════════════════════════════════════════════════════
   Dedupe / reclamo
   ═══════════════════════════════════════════════════════════ */

/**
 * ¿Ya se le mandó de verdad la confirmación a este teléfono en las últimas
 * 72h (por Dropi o por Shopify)? Se ignoran las filas de BLOQUEO
 * (source='sistema_local'), que no son envíos sino candados anti-cron, y la
 * fila de ESTA misma orden.
 */
async function yaSeEnvioConfirmacion({
  id_configuracion,
  phoneNorm,
  total,
  dropi_order_id,
}) {
  if (!phoneNorm) return false;
  const phone9 = phoneNorm.slice(-9);
  const tot = Number(total) || 0;

  const [row] = await db.query(
    `SELECT id FROM dropi_plantillas_enviadas
     WHERE id_configuracion = ?
       AND estado_dropi = ?
       AND source <> ?
       AND (dropi_order_id IS NULL OR dropi_order_id <> ?)
       AND (phone = ? OR phone LIKE ?)
       AND (total_order IS NULL OR ? = 0 OR ABS(total_order - ?) < 0.5)
       AND sent_at > NOW() - INTERVAL 72 HOUR
     LIMIT 1`,
    {
      replacements: [
        id_configuracion,
        ESTADO,
        SOURCE_BLOQUEO,
        dropi_order_id,
        phoneNorm,
        `%${phone9}`,
        tot,
        tot,
      ],
      type: db.QueryTypes.SELECT,
    },
  );
  return !!row;
}

/**
 * Reclama el envío ANTES de mandarlo (igual criterio que el notifier).
 *
 * Al crear la orden desde nuestro sistema, dropiOrders.service ya dejó una
 * fila de bloqueo (source='sistema_local', template '[SKIP] creada en
 * sistema') para que el cron/webhook de Dropi NUNCA mande esta confirmación.
 * Aquí convertimos ese candado en un envío real: si el UPDATE toca la fila,
 * ganamos el derecho a enviar. Si no existía la fila (orden creada por otro
 * camino) se intenta el INSERT IGNORE, que es atómico por el UNIQUE
 * uk_order_config_estado.
 */
async function reclamarEnvioBot({
  id_configuracion,
  dropi_order_id,
  phoneNorm,
  template_name,
  total,
}) {
  const [upd] = await db.query(
    `UPDATE dropi_plantillas_enviadas
        SET template_name = ?, source = ?, phone = ?, total_order = ?,
            sent_at = NOW()
      WHERE dropi_order_id = ? AND id_configuracion = ? AND estado_dropi = ?
        AND source = ?`,
    {
      replacements: [
        template_name,
        SOURCE_BOT,
        phoneNorm,
        Number(total) || null,
        dropi_order_id,
        id_configuracion,
        ESTADO,
        SOURCE_BLOQUEO,
      ],
    },
  );
  if (Number(upd?.affectedRows || 0) === 1) return true;

  const [ins] = await db.query(
    `INSERT IGNORE INTO dropi_plantillas_enviadas
       (dropi_order_id, id_configuracion, estado_dropi, phone, template_name,
        source, total_order)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    {
      replacements: [
        dropi_order_id,
        id_configuracion,
        ESTADO,
        phoneNorm,
        template_name,
        SOURCE_BOT,
        Number(total) || null,
      ],
    },
  );
  return Number(ins?.affectedRows || 0) === 1;
}

/**
 * El envío a Meta falló → devolvemos la fila a estado de BLOQUEO. A propósito
 * NO se libera el reclamo: si el mensaje no salió en el momento de la venta,
 * que el cron no lo mande una hora después, fuera de contexto.
 */
async function revertirReclamoBot({ id_configuracion, dropi_order_id }) {
  await db
    .query(
      `UPDATE dropi_plantillas_enviadas
          SET source = ?, template_name = '[SKIP] envío bot fallido'
        WHERE dropi_order_id = ? AND id_configuracion = ? AND estado_dropi = ?`,
      {
        replacements: [
          SOURCE_BLOQUEO,
          dropi_order_id,
          id_configuracion,
          ESTADO,
        ],
        type: db.QueryTypes.UPDATE,
      },
    )
    .catch(() => {});
}

async function completarEnvioBot({
  id_configuracion,
  dropi_order_id,
  wa_message_id,
}) {
  await db
    .query(
      `UPDATE dropi_plantillas_enviadas
          SET wa_message_id = ?
        WHERE dropi_order_id = ? AND id_configuracion = ? AND estado_dropi = ?`,
      {
        replacements: [
          wa_message_id || null,
          dropi_order_id,
          id_configuracion,
          ESTADO,
        ],
        type: db.QueryTypes.UPDATE,
      },
    )
    .catch(() => {});
}

/* ═══════════════════════════════════════════════════════════
   API pública
   ═══════════════════════════════════════════════════════════ */

/**
 * Manda la plantilla de PENDIENTE CONFIRMACION cuando el BOT cerró la venta
 * por WhatsApp y creó la orden. Best-effort: nunca lanza.
 *
 * @param {number} id_configuracion
 * @param {number} dropi_order_id  id de la orden recién creada en Dropi
 * @param {object} order           orden en el formato que entienden las
 *                                 variables de plantilla (mismo shape que el
 *                                 cache de Dropi: name, surname, phone, dir,
 *                                 city, state, total_order, orderdetails[])
 * @param {string} country_code    país de la integración (para normalizar tel)
 * @returns {Promise<{enviado:boolean, motivo?:string, wamid?:string}>}
 */
async function enviarConfirmacionOrdenBot({
  id_configuracion,
  dropi_order_id,
  order,
  country_code = 'EC',
}) {
  try {
    if (!id_configuracion || !dropi_order_id || !order) {
      return { enviado: false, motivo: 'parametros_incompletos' };
    }

    // 1. ¿El cliente tiene la plantilla activa y quiere que la mande el bot?
    const cfg = await getConfigPendienteConfirmacion(id_configuracion);
    if (!cfg || !Number(cfg.activo)) {
      return { enviado: false, motivo: 'estado_inactivo' };
    }
    if (!cfg.nombre_template || !String(cfg.nombre_template).trim()) {
      return { enviado: false, motivo: 'sin_plantilla' };
    }
    // Gate del cliente: apagado = el bot ya confirmó en el chat, no se
    // reconfirma por plantilla.
    if (Number(cfg.enviar_en_orden_bot) !== 1) {
      return { enviado: false, motivo: 'apagado_por_cliente' };
    }

    // 2. Credenciales WhatsApp de la cuenta
    const creds = await getWaCredentials(id_configuracion);
    if (!creds?.phone_number_id || !creds?.waba_token) {
      return { enviado: false, motivo: 'sin_credenciales_wa' };
    }

    const phoneNorm = normalizePhone(order.phone, country_code);
    if (!phoneNorm) return { enviado: false, motivo: 'telefono_invalido' };

    // 3. Dedupe cross-sistema (Shopify/Dropi ya confirmaron este pedido)
    const yaEnviado = await yaSeEnvioConfirmacion({
      id_configuracion,
      phoneNorm,
      total: order.total_order,
      dropi_order_id,
    });
    if (yaEnviado) return { enviado: false, motivo: 'ya_confirmado_72h' };

    // 4. Reclamo atómico
    const reclamado = await reclamarEnvioBot({
      id_configuracion,
      dropi_order_id,
      phoneNorm,
      template_name: cfg.nombre_template,
      total: order.total_order,
    });
    if (!reclamado) return { enviado: false, motivo: 'ya_reclamado' };

    // 5. Envío
    const orderParaMsg = { ...order, phone: phoneNorm };
    const components = buildTemplateComponents(
      cfg.parametros_json,
      orderParaMsg,
    );

    let wamid = null;
    let jsonMensaje = null;
    try {
      const result = await enviarTemplate({
        phone_number_id: creds.phone_number_id,
        waba_token: creds.waba_token,
        phoneNorm,
        templateName: cfg.nombre_template,
        languageCode: cfg.language_code || 'es',
        components,
      });
      wamid = result.wamid;
      jsonMensaje = result.payload;
    } catch (sendErr) {
      await revertirReclamoBot({ id_configuracion, dropi_order_id });
      console.error(
        `[seguimiento][bot] cfg=${id_configuracion} orden=${dropi_order_id} falló el envío:`,
        sendErr?.response?.data?.error?.message || sendErr.message,
      );
      return { enviado: false, motivo: 'error_meta' };
    }

    // ✅ El mensaje YA SALIÓ. Lo que sigue es best-effort.
    await completarEnvioBot({
      id_configuracion,
      dropi_order_id,
      wa_message_id: wamid,
    });

    const { clienteId, idClienteConfig } = await resolverClientes({
      id_configuracion,
      phoneNorm,
      phone_number_id: creds.phone_number_id,
      telefonoConfig: creds.telefono,
    });

    const textoEnviado =
      interpolarBodyText(cfg.body_text, components) || cfg.nombre_template;

    await registrarMensajeEnChat({
      id_configuracion,
      phone_number_id: creds.phone_number_id,
      clienteId,
      idClienteConfig,
      phoneNorm,
      tipoEnvio: 'template',
      textoMensaje: textoEnviado,
      templateName: cfg.nombre_template,
      languageCode: cfg.language_code || 'es',
      waMessageId: wamid,
      rutaArchivo: buildRutaArchivo(orderParaMsg, ESTADO),
      jsonMensaje,
      responsable: 'Bot Confirmación',
    });

    // OJO: NO se mueve de columna. La venta la cerró el bot, el contacto se
    // queda en generar_guia; mandarlo a pendiente_confirmacion sería hacerlo
    // retroceder en el tablero.
    console.log(
      `[seguimiento][bot] confirmación enviada cfg=${id_configuracion} orden=${dropi_order_id} tel=${phoneNorm}`,
    );
    return { enviado: true, wamid };
  } catch (err) {
    console.error(
      '[seguimiento][bot] error inesperado:',
      err?.message || String(err),
    );
    return { enviado: false, motivo: 'error_inesperado' };
  }
}

module.exports = { enviarConfirmacionOrdenBot };
