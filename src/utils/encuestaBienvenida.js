/**
 * encuestaBienvenida.js
 *
 * Envío del mensaje que recibe el contacto cuando entra por una encuesta:
 * texto libre si está dentro de la ventana de 24h de Meta, plantilla si está
 * fuera. Vivía dentro de `webhoook_contactos.controller.js`; se extrajo aquí
 * cuando el link público de la encuesta empezó a necesitar exactamente el
 * mismo envío. Fuente única de verdad para los dos caminos.
 *
 * La diferencia entre ambos está en `omitirSiPideEncuesta` — ver abajo.
 */

const { db } = require('../database/config');
const { QueryTypes } = require('sequelize');
const ChatService = require('../services/chat.service');
const whatsappService = require('../services/whatsapp.service');
const {
  construirLinkEncuesta,
  parseTemplateParams,
  resolverPlaceholders,
  esPlaceholderLink,
} = require('./encuestaTemplateLink');

/**
 * Detecta si el mensaje configurado lo que hace es mandar al cliente a llenar
 * la encuesta ({link_encuesta} o su alias {link}).
 */
function pideLlenarEncuesta(texto) {
  return esPlaceholderLink(texto);
}

/** ¿Alguno de los parámetros de la plantilla es el link de la encuesta? */
function templatePideLlenarEncuesta(templateParameters) {
  return parseTemplateParams(templateParameters).some(esPlaceholderLink);
}

/**
 * Detecta si el cliente está dentro de la ventana de 24h de Meta.
 * Aislado por id_configuracion (multi-tenant seguro).
 */
async function estaDentroVentana24h({ idCliente, idConfiguracion }) {
  try {
    const [row] = await db.query(
      `SELECT MAX(created_at) AS last_in
         FROM mensajes_clientes
        WHERE celular_recibe = :idCliente
          AND id_configuracion = :idConfiguracion
          AND (direction = 'in' OR rol_mensaje = 0)
          AND deleted_at IS NULL`,
      {
        replacements: { idCliente: String(idCliente), idConfiguracion },
        type: QueryTypes.SELECT,
      },
    );

    if (!row?.last_in) return false;
    const diffMs = Date.now() - new Date(row.last_in).getTime();
    return diffMs < 24 * 60 * 60 * 1000;
  } catch (err) {
    console.error(
      '[encuestaBienvenida] Error detectando ventana 24h:',
      err.message,
    );
    return false; // ante duda → fuera de ventana → template (más seguro)
  }
}

/**
 * Envía el mensaje de bienvenida según ventana 24h.
 * Fire-and-forget: nunca hace throw, solo loguea.
 *
 * @param {boolean} opts.omitirSiPideEncuesta
 *   Solo para el link público. Ahí el cliente ACABA de llenar la encuesta, así
 *   que si el mensaje configurado incluye {link_encuesta} se estaría pidiendo
 *   volver a responder lo que se acaba de responder: en ese caso no se manda
 *   nada. Un mensaje sin esa variable ("gracias por llenar el formulario") sí
 *   se envía. Desde el webhook va en false — ahí el link es justamente el
 *   punto del mensaje y el comportamiento no cambia en nada.
 */
async function enviarMensajeBienvenida({
  idCliente,
  idConfiguracion,
  idEncuesta,
  telefono,
  encuestaCfg,
  contacto: contactoBase,
  responsable = 'Encuesta Webhook',
  logPrefix = '[webhook_contactos]',
  omitirSiPideEncuesta = false,
}) {
  try {
    // El link de la encuesta es único por cliente: se resuelve en cada envío
    // y queda disponible como {link_encuesta} tanto en el texto como en los
    // parámetros del template.
    const contacto = {
      ...contactoBase,
      link_encuesta: construirLinkEncuesta(idEncuesta, idCliente),
    };

    const hayTexto = !!(encuestaCfg.mensaje_dentro_24h || '').trim();
    const hayTemplate = !!(encuestaCfg.template_fuera_24h || '').trim();

    if (!hayTexto && !hayTemplate) {
      console.log(
        `${logPrefix} Encuesta sin mensaje configurado — no se envía nada`,
      );
      return { enviado: false, motivo: 'sin_configuracion' };
    }

    const dentroVentana = await estaDentroVentana24h({
      idCliente,
      idConfiguracion,
    });
    console.log(
      `${logPrefix} Ventana 24h: ${dentroVentana ? 'DENTRO' : 'FUERA'} → cliente=${idCliente} config=${idConfiguracion}`,
    );

    // ── DENTRO 24h → texto libre ──
    if (dentroVentana && hayTexto) {
      if (
        omitirSiPideEncuesta &&
        pideLlenarEncuesta(encuestaCfg.mensaje_dentro_24h)
      ) {
        console.log(
          `${logPrefix} El texto de 24h lleva el link de la encuesta y el cliente acaba de responderla — no se envía`,
        );
        return { enviado: false, motivo: 'omitido_pide_encuesta' };
      }

      const chatService = new ChatService();
      const dataAdmin = await chatService.getDataAdmin(idConfiguracion);

      if (!dataAdmin) {
        console.error(
          `${logPrefix} No se pudo obtener dataAdmin para config`,
          idConfiguracion,
        );
        return { enviado: false, motivo: 'sin_data_admin' };
      }

      const textoFinal = resolverPlaceholders(
        encuestaCfg.mensaje_dentro_24h,
        contacto,
      );

      await chatService.sendMessage({
        mensaje: textoFinal,
        to: telefono,
        dataAdmin,
        tipo_mensaje: 'text',
        id_configuracion: idConfiguracion,
        nombre_encargado: responsable,
      });

      console.log(`${logPrefix} ✅ Texto enviado (dentro 24h) → ${telefono}`);
      return { enviado: true, tipo: 'texto' };
    }

    // ── FUERA 24h (o sin texto configurado) → template ──
    if (!hayTemplate) {
      console.log(
        `${logPrefix} Fuera de 24h y sin template configurado — no se envía`,
      );
      return { enviado: false, motivo: 'fuera_24h_sin_template' };
    }

    if (
      omitirSiPideEncuesta &&
      templatePideLlenarEncuesta(encuestaCfg.template_parameters)
    ) {
      console.log(
        `${logPrefix} La plantilla "${encuestaCfg.template_fuera_24h}" manda el link de la encuesta y el cliente acaba de responderla — no se envía`,
      );
      return { enviado: false, motivo: 'omitido_pide_encuesta' };
    }

    // Template puede no tener variables → paramsRaw = []
    const paramsRaw = parseTemplateParams(encuestaCfg.template_parameters);

    // Si tiene variables, resolver placeholders con default amigable
    // (Meta rechaza parámetros vacíos con error 132000)
    const paramsResueltos = paramsRaw.map((p, idx) => {
      const resuelto = resolverPlaceholders(String(p ?? ''), contacto);

      if (!resuelto || !resuelto.trim()) {
        const esLink = esPlaceholderLink(p);
        console.warn(
          esLink
            ? `${logPrefix} ⚠️ Parámetro {{${idx + 1}}} es el link de la encuesta pero quedó vacío (idEncuesta=${idEncuesta} idCliente=${idCliente}). Se reemplaza por "-"`
            : `${logPrefix} ⚠️ Parámetro {{${idx + 1}}} quedó vacío — placeholder original: "${p}". Se reemplaza por "-"`,
        );
        return '-';
      }
      return resuelto;
    });

    const result = await whatsappService.sendWhatsappMessageTemplateScheduled({
      telefono,
      id_configuracion: idConfiguracion,
      responsable,
      nombre_template: encuestaCfg.template_fuera_24h,
      template_parameters: paramsResueltos, // [] si el template no tiene variables
    });

    console.log(
      `${logPrefix} ✅ Template "${encuestaCfg.template_fuera_24h}" enviado (fuera 24h) → ${telefono} wamid=${result?.wamid} params=${paramsResueltos.length}`,
    );
    return { enviado: true, tipo: 'template', wamid: result?.wamid };
  } catch (err) {
    console.error(`${logPrefix} ❌ Error enviando mensaje bienvenida:`, {
      message: err.message,
      meta_error: err.meta_error || null,
    });
    return { enviado: false, motivo: 'error', error: err.message };
  }
}

module.exports = {
  pideLlenarEncuesta,
  templatePideLlenarEncuesta,
  estaDentroVentana24h,
  enviarMensajeBienvenida,
};
