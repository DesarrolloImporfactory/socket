// services/kanban_ia.service.js
// Función genérica que reemplaza todo el switch ventas/eventos/imporfactory.
// Lee el assistant_id y las acciones desde kanban_columnas + kanban_acciones,
// ejecuta el asistente OpenAI y procesa todas las acciones configuradas.
// ─────────────────────────────────────────────────────────────

const axios = require('axios');
const flatted = require('flatted');
const { db } = require('../database/config');

const {
  enviarMensajeWhatsapp,
} = require('../utils/webhook_whatsapp/enviarMensajes');

const {
  enviarMedioWhatsapp,
} = require('../utils/webhook_whatsapp/enviarMultimedia');

const { obtenerOCrearThreadId } = require('../services/obtener_thread.service');

const servicioAppointments = require('../services/appointments.service');

const logsDir = require('path').join(process.cwd(), './src/logs/logs_meta');
const fs = require('fs').promises;

async function log(msg) {
  await fs.mkdir(logsDir, { recursive: true });
  await fs.appendFile(
    require('path').join(logsDir, 'debug_log.txt'),
    `[${new Date().toISOString()}] [kanban_ia] ${msg}\n`,
  );
}

// ─────────────────────────────────────────────────────────────
// procesarMensajeKanban
// Punto de entrada único desde el webhook.
//
// @param {object} params
//   id_configuracion, id_cliente, telefono, mensaje,
//   estado_contacto, api_key_openai,
//   business_phone_id, accessToken
//
// @returns {object} { ok, respuesta_enviada }
// ─────────────────────────────────────────────────────────────
async function procesarMensajeKanban(params) {
  const {
    id_configuracion,
    id_cliente,
    telefono,
    mensaje,
    estado_contacto,
    api_key_openai,
    business_phone_id,
    accessToken,
  } = params;

  // ── 1. Obtener configuración de la columna activa ─────────
  const [columna] = await db.query(
    `SELECT kc.id, kc.nombre, kc.assistant_id, kc.activa_ia,
            kc.max_tokens, kc.vector_store_id
     FROM   kanban_columnas kc
     WHERE  kc.id_configuracion = ?
       AND  LOWER(kc.estado_db) = LOWER(?)
       AND  kc.activo = 1
     LIMIT 1`,
    {
      replacements: [id_configuracion, estado_contacto],
      type: db.QueryTypes.SELECT,
    },
  );

  if (!columna) {
    await log(
      `⚠️ Sin columna para estado=${estado_contacto} config=${id_configuracion}`,
    );
    return { ok: false, motivo: 'sin_columna' };
  }

  if (!columna.activa_ia || !columna.assistant_id) {
    await log(
      `ℹ️ IA inactiva para columna "${columna.nombre}" (activa_ia=${columna.activa_ia})`,
    );
    return { ok: false, motivo: 'ia_inactiva' };
  }

  // ── 2. Obtener acciones configuradas para esta columna ────
  const acciones = await db.query(
    `SELECT tipo_accion, config, orden
     FROM   kanban_acciones
     WHERE  id_kanban_columna = ? AND activo = 1
     ORDER  BY orden ASC`,
    { replacements: [columna.id], type: db.QueryTypes.SELECT },
  );

  const tieneAccion = (tipo) => acciones.some((a) => a.tipo_accion === tipo);
  const getAcciones = (tipo) => acciones.filter((a) => a.tipo_accion === tipo);
  const parseConfig = (a) => {
    try {
      let cfg = a?.config;

      if (!cfg) return {};

      // Intentar deserializar mientras siga siendo string JSON
      while (typeof cfg === 'string') {
        cfg = JSON.parse(cfg);
      }

      return cfg && typeof cfg === 'object' ? cfg : {};
    } catch (error) {
      return {};
    }
  };

  // ── 3. Obtener thread del cliente ─────────────────────────
  const id_thread = await obtenerOCrearThreadId(id_cliente, api_key_openai);
  if (!id_thread) {
    await log(`⚠️ No se pudo obtener thread para id_cliente=${id_cliente}`);
    return { ok: false, motivo: 'sin_thread' };
  }

  const headers = {
    Authorization: `Bearer ${api_key_openai}`,
    'Content-Type': 'application/json',
    'OpenAI-Beta': 'assistants=v2',
  };

  let bloqueContexto = '';
  let total_tokens = 0;
  let mensajeFinal = mensaje;

  // ── 4. ACCIÓN: separador_productos (pre-procesamiento) ────
  if (tieneAccion('separador_productos')) {
    const [acSep] = getAcciones('separador_productos');
    const cfg = parseConfig(acSep);
    const sep_asst = cfg.assistant_id || null;

    if (sep_asst) {
      try {
        const sepResult = await ejecutarAsistente({
          id_thread,
          assistant_id: sep_asst,
          mensaje,
          max_tokens: 100,
          headers,
        });
        if (sepResult.respuesta) {
          bloqueContexto += `📦 Productos mencionados en el mensaje:\n${sepResult.respuesta}\n\n`;
          total_tokens += sepResult.total_tokens;
          await log(`✅ Separador productos: ${sepResult.respuesta}`);
        }
      } catch (err) {
        await log(`⚠️ Error separador_productos: ${err.message}`);
      }
    }
  }

  // ── 5. ACCIÓN: contexto_productos ─────────────────────────
  if (tieneAccion('contexto_productos') && bloqueContexto) {
    // El catálogo ya está en el vector_store del asistente (file_search).
    // Aquí solo inyectamos el bloque del separador como mensaje de contexto.
    // Si no hay separador, el file_search del asistente ya tiene el catálogo completo.
    await log(
      `ℹ️ contexto_productos activo — catálogo en vector_store="${columna.vector_store_id}"`,
    );
  }

  // ── 6. ACCIÓN: contexto_calendario ────────────────────────
  if (tieneAccion('contexto_calendario')) {
    try {
      const {
        obtenerDatosCalendarioParaAssistant,
      } = require('../utils/datosClienteAssistant');
      const datosCalendario =
        await obtenerDatosCalendarioParaAssistant(id_configuracion);
      if (datosCalendario?.bloque) {
        bloqueContexto += `📅 Información del calendario:\n${datosCalendario.bloque}\n\n`;
        await log(`✅ Contexto calendario inyectado`);
      }
    } catch (err) {
      await log(`⚠️ Error contexto_calendario: ${err.message}`);
    }
  }

  // ── 7. Enviar contexto al thread (si hay) ─────────────────
  if (bloqueContexto.trim()) {
    await axios
      .post(
        `https://api.openai.com/v1/threads/${id_thread}/messages`,
        {
          role: 'user',
          content: `🧾 Contexto adicional:\n\n${bloqueContexto.trim()}`,
        },
        { headers },
      )
      .catch(async (err) => log(`⚠️ Error enviando contexto: ${err.message}`));
  }

  // ── 8. Enviar mensaje del usuario ─────────────────────────
  await axios
    .post(
      `https://api.openai.com/v1/threads/${id_thread}/messages`,
      { role: 'user', content: mensajeFinal },
      { headers },
    )
    .catch(async (err) => log(`⚠️ Error enviando mensaje: ${err.message}`));

  // ── 9. Ejecutar asistente principal ───────────────────────
  const resultado = await ejecutarAsistente({
    id_thread,
    assistant_id: columna.assistant_id,
    mensaje: null, // ya enviado arriba
    max_tokens: columna.max_tokens || 500,
    headers,
    skip_send_message: true, // mensaje ya fue enviado
  });

  if (!resultado || !resultado.respuesta) {
    await log(`⚠️ Asistente sin respuesta para columna="${columna.nombre}"`);
    return { ok: false, motivo: 'sin_respuesta_asistente' };
  }

  total_tokens += resultado.total_tokens;
  const respuestaRaw = resultado.respuesta;
  await log(
    `✅ Respuesta asistente columna="${columna.nombre}": ${respuestaRaw.slice(0, 120)}...`,
  );

  await log(`🧪 Acciones cargadas: ${JSON.stringify(acciones)}`);
  await log(
    `🧪 Acciones cambiar_estado: ${JSON.stringify(getAcciones('cambiar_estado'))}`,
  );

  // ── 10. ACCIÓN: cambiar_estado ────────────────────────────
  for (const ac of getAcciones('cambiar_estado')) {
    const cfg = parseConfig(ac);
    const trigger = cfg.trigger || '';
    const estadoDestino = cfg.estado_destino || '';
    if (!trigger || !estadoDestino) continue;

    const coincide = respuestaRaw.toLowerCase().includes(trigger.toLowerCase());
    if (coincide) {
      await db.query(
        `UPDATE clientes_chat_center SET estado_contacto = ? WHERE id = ?`,
        {
          replacements: [estadoDestino, id_cliente],
          type: db.QueryTypes.UPDATE,
        },
      );
      await log(
        `🔄 Estado cambiado a "${estadoDestino}" (trigger="${trigger}")`,
      );
      // No break — puede haber múltiples cambios de estado (poco común pero posible)
    }
  }

  // ── 11. ACCIÓN: agendar_cita ──────────────────────────────
  if (tieneAccion('agendar_cita')) {
    const [acCita] = getAcciones('agendar_cita');
    const cfg = parseConfig(acCita);
    const trigger = cfg.trigger || '[cita_confirmada]: true';

    if (respuestaRaw.toLowerCase().includes(trigger.toLowerCase())) {
      await procesarAgendarCita(
        respuestaRaw,
        id_configuracion,
        id_cliente,
      ).catch(async (err) => log(`⚠️ Error agendar_cita: ${err.message}`));
    }
  }

  // ── 12. ACCIÓN: enviar_media ──────────────────────────────
  let soloTexto = respuestaRaw;

  if (tieneAccion('enviar_media')) {
    const { texto, imagenes, videos } = extraerMedia(respuestaRaw);
    soloTexto = texto;

    for (const url of imagenes) {
      await enviarMedioWhatsapp({
        tipo: 'image',
        url_archivo: url,
        phone_whatsapp_to: telefono,
        business_phone_id,
        accessToken,
        id_configuracion,
        responsable: `IA_${columna.nombre}`,
      }).catch(async (err) => log(`⚠️ Error enviando imagen: ${err.message}`));
    }
    for (const url of videos) {
      await enviarMedioWhatsapp({
        tipo: 'video',
        url_archivo: url,
        phone_whatsapp_to: telefono,
        business_phone_id,
        accessToken,
        id_configuracion,
        responsable: `IA_${columna.nombre}`,
      }).catch(async (err) => log(`⚠️ Error enviando video: ${err.message}`));
    }
  }

  // ── 13. Enviar texto final ────────────────────────────────
  // Limpiar tags de acciones del texto
  soloTexto = limpiarTagsAcciones(soloTexto).trim();

  if (soloTexto) {
    await enviarMensajeWhatsapp({
      phone_whatsapp_to: telefono,
      texto_mensaje: soloTexto,
      business_phone_id,
      accessToken,
      id_configuracion,
      responsable: `IA_${columna.nombre}`,
      total_tokens,
    });
  }

  return { ok: true, respuesta_enviada: soloTexto, total_tokens };
}

// ══════════════════════════════════════════════════════════════
// ejecutarAsistente — polling OpenAI
// ══════════════════════════════════════════════════════════════
async function ejecutarAsistente({
  id_thread,
  assistant_id,
  mensaje,
  max_tokens = 500,
  headers,
  skip_send_message = false,
}) {
  // Enviar mensaje si se requiere
  if (!skip_send_message && mensaje) {
    await axios.post(
      `https://api.openai.com/v1/threads/${id_thread}/messages`,
      { role: 'user', content: mensaje },
      { headers },
    );
  }

  // Crear run
  const runRes = await axios.post(
    `https://api.openai.com/v1/threads/${id_thread}/runs`,
    { assistant_id, max_completion_tokens: max_tokens },
    { headers },
  );
  const run_id = runRes?.data?.id;
  if (!run_id) throw new Error('No se pudo crear run');

  // Polling
  let statusRun = 'queued';
  let attempts = 0;
  let total_tokens = 0;

  while (statusRun !== 'completed' && statusRun !== 'failed' && attempts < 25) {
    await new Promise((r) => setTimeout(r, 1200));
    attempts++;
    const statusRes = await axios.get(
      `https://api.openai.com/v1/threads/${id_thread}/runs/${run_id}`,
      { headers },
    );
    statusRun = statusRes.data.status;
    if (statusRes.data.usage) {
      total_tokens = statusRes.data.usage.total_tokens || 0;
    }
    await log(`run ${run_id} intento=${attempts} status=${statusRun}`);

    if (statusRun === 'failed') {
      const lastErr = statusRes.data.last_error;
      throw new Error(`Run falló: ${JSON.stringify(lastErr)}`);
    }
  }

  if (statusRun !== 'completed')
    throw new Error(`Run no completó (status=${statusRun})`);

  // Obtener respuesta
  const messagesRes = await axios.get(
    `https://api.openai.com/v1/threads/${id_thread}/messages`,
    { headers },
  );
  const mensajes = messagesRes.data.data || [];
  const respuesta =
    mensajes
      .reverse()
      .find((m) => m.role === 'assistant' && m.run_id === run_id)?.content?.[0]
      ?.text?.value || '';

  return { respuesta, total_tokens };
}

// ══════════════════════════════════════════════════════════════
// Helpers de procesamiento de respuesta
// ══════════════════════════════════════════════════════════════

function extraerMedia(texto) {
  const imagenes = (
    texto.match(
      /\[(producto_imagen_url|servicio_imagen_url|upsell_imagen_url)\]:\s*(https?:\/\/[^\s]+)/gi,
    ) || []
  )
    .map((s) => {
      const m = s.match(/\]:\s*(https?:\/\/[^\s]+)/i);
      return m ? m[1] : null;
    })
    .filter(Boolean);

  const videos = (
    texto.match(
      /\[(producto_video_url|servicio_video_url)\]:\s*(https?:\/\/[^\s]+)/gi,
    ) || []
  )
    .map((s) => {
      const m = s.match(/\]:\s*(https?:\/\/[^\s]+)/i);
      return m ? m[1] : null;
    })
    .filter(Boolean);

  let textoLimpio = texto
    .replace(
      /\[(producto_imagen_url|servicio_imagen_url|upsell_imagen_url)\]:\s*https?:\/\/[^\s]+/gi,
      '',
    )
    .replace(
      /\[(producto_video_url|servicio_video_url)\]:\s*https?:\/\/[^\s]+/gi,
      '',
    );

  return { texto: textoLimpio, imagenes, videos };
}

function limpiarTagsAcciones(texto) {
  return texto
    .replace(/\[pedido_confirmado\]:\s*(true|false)/gi, '')
    .replace(/\[cita_confirmada\]:\s*(true|false)/gi, '')
    .replace(/\[asesor_confirmado\]:\s*(true|false)/gi, '')
    .replace(/\[atencion_urgente\]:\s*(true|false)/gi, '')
    .replace(/\[[^\]]+\]:\s*(true|false)/gi, '') // cualquier tag booleano
    .trim();
}

async function procesarAgendarCita(mensajeGPT, id_configuracion, id_cliente) {
  const moment = require('moment-timezone');

  const nombre = mensajeGPT.match(/🧑 Nombre:\s*(.+)/)?.[1]?.trim() || '';
  const telefono = mensajeGPT.match(/📞 Teléfono:\s*(.+)/)?.[1]?.trim() || '';
  const correo = mensajeGPT.match(/📍 Correo:\s*(.+)/)?.[1]?.trim() || '';
  const servicio =
    mensajeGPT.match(/📍 Servicio que desea:\s*(.+)/)?.[1]?.trim() || '';
  const fechaIni =
    mensajeGPT.match(/🕒 Fecha y hora de inicio:\s*(.+)/)?.[1]?.trim() || '';
  const fechaFin =
    mensajeGPT.match(/🕒 Fecha y hora de fin:\s*(.+)/)?.[1]?.trim() || '';

  const inicio_utc = moment.tz(fechaIni, 'America/Guayaquil').utc().format();
  const fin_utc = moment.tz(fechaFin, 'America/Guayaquil').utc().format();

  const [calendar] = await db.query(
    `SELECT id FROM calendars WHERE account_id = ? LIMIT 1`,
    { replacements: [id_configuracion], type: db.QueryTypes.SELECT },
  );

  const [usuario] = await db.query(
    `SELECT sb.id_sub_usuario, sb.id_usuario
     FROM configuraciones c
     INNER JOIN sub_usuarios_chat_center sb ON sb.id_usuario = c.id_usuario
     WHERE c.id = ? AND sb.rol = 'administrador' LIMIT 1`,
    { replacements: [id_configuracion], type: db.QueryTypes.SELECT },
  );

  if (!calendar || !usuario) {
    await log(
      `⚠️ agendar_cita: no se encontró calendar o usuario para config=${id_configuracion}`,
    );
    return;
  }

  const payload = {
    assigned_user_id: usuario.id_sub_usuario,
    booked_tz: 'America/Guayaquil',
    calendar_id: calendar.id,
    create_meet: true,
    created_by_user_id: usuario.id_usuario,
    description: '',
    end: fin_utc,
    invitees: [{ name: nombre, email: correo, phone: telefono }],
    location_text: 'online',
    meeting_url: null,
    start: inicio_utc,
    status: 'Agendado',
    title: `${nombre} - ${servicio}`,
  };

  await servicioAppointments.createAppointment(payload, usuario.id_usuario);
  await log(`✅ Cita agendada: ${nombre} - ${servicio} - ${inicio_utc}`);
}

module.exports = { procesarMensajeKanban };
