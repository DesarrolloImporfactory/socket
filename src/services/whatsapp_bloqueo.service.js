'use strict';

/* Bloquear / desbloquear un contacto de WhatsApp desde el chat.
   ─────────────────────────────────────────────────────────────
   Quien usa coexistencia bloquea desde el celular. Quien tiene solo API no
   tenía cómo sacarse de encima a un contacto que insulta o hace spam. Meta lo
   permite con la Block Users API:

     POST   /{phone_number_id}/block_users   → bloquea
     DELETE /{phone_number_id}/block_users   → desbloquea

   El bloqueo vive en Meta: el contacto deja de poder escribirle a ese número
   y el número deja de poder escribirle a él. La tabla `whatsapp_bloqueados`
   (whatsapp_bloqueados_migration.sql) es solo la constancia para pintar el
   estado en el chat y saber quién lo hizo.

   Reglas de Meta que explican casi todos los rechazos:
     · solo se puede bloquear a quien escribió en las últimas 24 horas (131047);
     · no se puede bloquear el número propio (131021);
     · la lista admite hasta 64.000 contactos (139101).

   No confundir con utils/contactosBloqueados.js, que es la lista interna de
   «no mandarle envíos automáticos» y no toca Meta. */

const axios = require('axios');
const { db } = require('../database/config');
const { auditarDesdeChat } = require('./switch_audit.service');
const { olvidarBloqueadosWhatsapp } = require('../utils/contactosBloqueados');

/** Mensaje para el asesor según el código con que Meta rechazó. */
const MOTIVOS = {
  131047:
    'WhatsApp solo permite bloquear a contactos que te escribieron en las últimas 24 horas.',
  131021: 'No puedes bloquear tu propio número.',
  139101:
    'Tu número llegó al límite de contactos bloqueados que permite WhatsApp (64.000).',
  139102:
    'WhatsApp estaba actualizando la lista de bloqueados. Intenta de nuevo.',
  139103: 'WhatsApp tuvo un error interno. Intenta de nuevo en un momento.',
  130429:
    'WhatsApp está limitando las peticiones de este número. Intenta de nuevo en un momento.',
  190: 'El token de la conexión de WhatsApp venció. Reconecta el número e intenta de nuevo.',
};

class BloqueoError extends Error {
  constructor(message, status = 400, code = null) {
    super(message);
    this.status = status;
    this.codigoMeta = code;
  }
}

function soloDigitos(v) {
  return String(v || '').replace(/\D/g, '');
}

/** El chat con lo que hace falta de su conexión para hablarle a Meta. */
async function cargarChat(chatId) {
  const [chat] = await db.query(
    `SELECT c.id, c.id_configuracion, c.celular_cliente, c.source,
            c.bot_openia, c.enviar_remarketing,
            cf.id_telefono, cf.token
       FROM clientes_chat_center c
       INNER JOIN configuraciones cf ON cf.id = c.id_configuracion
      WHERE c.id = ?
      LIMIT 1`,
    { replacements: [chatId], type: db.QueryTypes.SELECT },
  );
  return chat || null;
}

/** Saca de la respuesta de Meta el primer motivo concreto del rechazo. */
function leerRechazo(data) {
  const fallido = data?.block_users?.failed_users?.[0];
  const errFallido = fallido?.errors?.[0];
  const errGlobal = data?.error;

  // El error por contacto dice el porqué; el global (139100) solo dice que
  // «falló el bloqueo de algunos», así que va de respaldo.
  const code = Number(errFallido?.code || errGlobal?.code || 0) || null;
  const detalle =
    errFallido?.error_data?.details ||
    errFallido?.message ||
    errGlobal?.error_data?.details ||
    errGlobal?.message ||
    null;

  return { code, detalle, hayFallidos: Boolean(fallido || errGlobal) };
}

async function llamarMeta({ metodo, id_telefono, token, celular }) {
  const url = `https://graph.facebook.com/${process.env.GRAPH_VERSION}/${id_telefono}/block_users`;
  try {
    const { data } = await axios({
      method: metodo,
      url,
      data: {
        messaging_product: 'whatsapp',
        block_users: [{ user: celular }],
      },
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      timeout: 20000,
    });
    return data;
  } catch (err) {
    // Meta responde el rechazo con cuerpo: se devuelve para leerlo igual que
    // una respuesta normal. Sin cuerpo es un fallo de red.
    if (err.response?.data) return err.response.data;
    throw new BloqueoError(
      'No se pudo conectar con WhatsApp. Intenta de nuevo.',
      502,
    );
  }
}

/** ¿Está bloqueado este chat? (según nuestra constancia) */
async function estadoBloqueo(chatId) {
  try {
    const [fila] = await db.query(
      `SELECT nombre_sub_usuario, created_at
         FROM whatsapp_bloqueados
        WHERE id_cliente_chat_center = ?
        LIMIT 1`,
      { replacements: [chatId], type: db.QueryTypes.SELECT },
    );
    return {
      bloqueado: Boolean(fila),
      bloqueado_por: fila?.nombre_sub_usuario || null,
      bloqueado_at: fila?.created_at || null,
    };
  } catch (e) {
    // Sin la tabla (migración sin correr) el menú igual tiene que abrir.
    console.error('[whatsapp_bloqueo] no se pudo leer el estado:', e.message);
    return { bloqueado: false, bloqueado_por: null, bloqueado_at: null };
  }
}

/**
 * Bloquea o desbloquea en Meta y deja la constancia.
 * @param {object} p
 * @param {number} p.chatId
 * @param {boolean} p.bloquear  true = bloquear, false = desbloquear
 * @param {object} [p.req]      para saber quién lo hizo (req.sessionUser)
 */
async function cambiarBloqueo({ chatId, bloquear, req = null }) {
  const chat = await cargarChat(chatId);
  if (!chat) throw new BloqueoError('Chat no encontrado', 404);

  if (chat.source && chat.source !== 'wa') {
    throw new BloqueoError(
      'El bloqueo solo está disponible para chats de WhatsApp.',
    );
  }
  if (!chat.id_telefono || !chat.token) {
    throw new BloqueoError(
      'Esta conexión no tiene WhatsApp conectado. Reconecta el número e intenta de nuevo.',
    );
  }

  const celular = soloDigitos(chat.celular_cliente);
  if (!celular) {
    throw new BloqueoError('El contacto no tiene un número válido.');
  }

  const data = await llamarMeta({
    metodo: bloquear ? 'post' : 'delete',
    id_telefono: chat.id_telefono,
    token: chat.token,
    celular,
  });

  const hechos = bloquear
    ? data?.block_users?.added_users
    : data?.block_users?.removed_users;
  const ok = Array.isArray(hechos) && hechos.length > 0;

  if (!ok) {
    const { code, detalle } = leerRechazo(data);
    console.error(
      `[whatsapp_bloqueo] Meta rechazó ${bloquear ? 'bloquear' : 'desbloquear'} chat=${chatId} cfg=${chat.id_configuracion}:`,
      JSON.stringify(data).slice(0, 600),
    );

    throw new BloqueoError(
      MOTIVOS[code] ||
        (detalle
          ? `WhatsApp no permitió ${bloquear ? 'bloquear' : 'desbloquear'} este contacto: ${detalle}`
          : `WhatsApp no permitió ${bloquear ? 'bloquear' : 'desbloquear'} este contacto.`),
      400,
      code,
    );
  }

  const actor = req?.sessionUser || null;
  const cambios = bloquear
    ? await alBloquear({ chat, celular, wa_id: hechos[0]?.wa_id, actor })
    : await alDesbloquear({ chat });

  olvidarBloqueadosWhatsapp();

  // Rastro de los interruptores, igual que cuando se tocan a mano desde el
  // chat: si no, «yo no apagué el bot» no se puede contestar.
  for (const sw of ['bot_openia', 'enviar_remarketing']) {
    if (Number(chat[sw]) === Number(cambios[sw])) continue;
    await auditarDesdeChat(req, {
      id_cliente_chat_center: chat.id,
      switch_nombre: sw,
      valor_anterior: chat[sw],
      valor_nuevo: cambios[sw],
      detalle: bloquear
        ? 'apagado al bloquear el contacto en WhatsApp'
        : 'restaurado al desbloquear el contacto en WhatsApp',
    });
  }

  return { bloqueado: Boolean(bloquear), ...cambios };
}

/* Bloqueado en Meta, a ese contacto no le llega nada y él no puede escribir:
   todo lo automático que quede vivo solo gasta (tokens de IA al armar un
   seguimiento, intentos de envío que Meta rechaza). Se apaga el bot y el
   remarketing del chat y se cierra lo que estuviera en cola. Lo que se
   programe después lo frenan los crons con `estaBloqueado(tel, id_cfg)`. */
async function alBloquear({ chat, celular, wa_id, actor }) {
  // Los valores previos solo se guardan la primera vez: re-bloquear a alguien
  // ya bloqueado no puede pisarlos con los ceros que dejó el primer bloqueo.
  await db.query(
    `INSERT INTO whatsapp_bloqueados
       (id_configuracion, id_cliente_chat_center, celular,
        id_sub_usuario, nombre_sub_usuario,
        bot_openia_previo, enviar_remarketing_previo)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       celular = VALUES(celular)`,
    {
      replacements: [
        chat.id_configuracion,
        chat.id,
        soloDigitos(wa_id) || celular,
        actor?.id_sub_usuario || null,
        String(
          actor?.nombre_encargado || actor?.usuario || actor?.email || '',
        ).slice(0, 120) || null,
        Number(chat.bot_openia) ? 1 : 0,
        Number(chat.enviar_remarketing) ? 1 : 0,
      ],
      type: db.QueryTypes.INSERT,
    },
  );

  await db.query(
    `UPDATE clientes_chat_center
        SET bot_openia = 0, enviar_remarketing = 0
      WHERE id = ?`,
    { replacements: [chat.id], type: db.QueryTypes.UPDATE },
  );

  const [, remarketing] = await db.query(
    `UPDATE remarketing_pendientes
        SET cancelado = 1,
            error_message = 'Contacto bloqueado en WhatsApp'
      WHERE id_cliente_chat_center = ? AND enviado = 0 AND cancelado = 0`,
    { replacements: [chat.id], type: db.QueryTypes.UPDATE },
  );

  // 'error' y no 'cancelado': ese estado lo lee la lógica de lote cancelado
  // (mismo criterio que cron/templateProgramadoMasivo.js).
  const [, programados] = await db.query(
    `UPDATE template_envios_programados
        SET estado = 'error',
            error_message = '[BLOQUEADO] El contacto está bloqueado en WhatsApp',
            actualizado_en = NOW()
      WHERE id_cliente_chat_center = ? AND estado = 'pendiente'`,
    { replacements: [chat.id], type: db.QueryTypes.UPDATE },
  );

  const [, encuestas] = await db.query(
    `UPDATE encuestas_envios_programados
        SET estado = 'cancelado', error_ultimo = 'contacto_bloqueado_whatsapp'
      WHERE id_cliente_chat_center = ? AND estado = 'pendiente'`,
    { replacements: [chat.id], type: db.QueryTypes.UPDATE },
  );

  return {
    bot_openia: 0,
    enviar_remarketing: 0,
    cancelados: {
      remarketing: Number(remarketing || 0),
      programados: Number(programados || 0),
      encuestas: Number(encuestas || 0),
    },
  };
}

/* Al desbloquear vuelven el bot y el remarketing a como estaban. Lo que se
   canceló en cola NO se revive: eran mensajes pensados para otro momento. */
async function alDesbloquear({ chat }) {
  const [previo] = await db.query(
    `SELECT bot_openia_previo, enviar_remarketing_previo
       FROM whatsapp_bloqueados
      WHERE id_cliente_chat_center = ?
      LIMIT 1`,
    { replacements: [chat.id], type: db.QueryTypes.SELECT },
  );

  const restaurar = (valorPrevio, actual) =>
    valorPrevio === null || typeof valorPrevio === 'undefined'
      ? Number(actual) ? 1 : 0
      : Number(valorPrevio) ? 1 : 0;

  const bot_openia = restaurar(previo?.bot_openia_previo, chat.bot_openia);
  const enviar_remarketing = restaurar(
    previo?.enviar_remarketing_previo,
    chat.enviar_remarketing,
  );

  await db.query(
    `UPDATE clientes_chat_center
        SET bot_openia = ?, enviar_remarketing = ?
      WHERE id = ?`,
    {
      replacements: [bot_openia, enviar_remarketing, chat.id],
      type: db.QueryTypes.UPDATE,
    },
  );

  await db.query(
    `DELETE FROM whatsapp_bloqueados WHERE id_cliente_chat_center = ?`,
    { replacements: [chat.id], type: db.QueryTypes.DELETE },
  );

  return { bot_openia, enviar_remarketing };
}

module.exports = { cambiarBloqueo, estadoBloqueo, BloqueoError };
