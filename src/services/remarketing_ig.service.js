// services/remarketing_ig.service.js
// -----------------------------------------------------------------------------
// Remarketing kanban para Instagram (v1).
//
// Reutiliza la MISMA tabla `remarketing_pendientes` (columna source='ig') y la
// MISMA `configuracion_remarketing` que WhatsApp. A diferencia de WA, Instagram
// NO tiene templates de pago: el remarketing solo es viable DENTRO de la ventana
// de 24h. Por eso v1 soporta únicamente el método IA (metodo_dentro_24h='ia').
//
// - programarRemarketingIG(): agenda el disparo leyendo configuracion_remarketing.
// - generarRemarketingIgIA(): genera el texto de reenganche con el asistente,
//   soportando tanto la Responses API (config 10) como la Assistants API (threads),
//   igual que procesarMensajeKanban.
//
// La cancelación al responder el cliente se hace con cancelarRemarketingKanban
// (de kanban_ia.service), que ya es agnóstica al canal.
// -----------------------------------------------------------------------------

const { db } = require('../database/config');
const path = require('path');
const fs = require('fs').promises;

const { obtenerUltimoResponseId } = require('./obtener_response.service');

const logsDir = path.join(process.cwd(), './src/logs/logs_meta');
async function log(msg) {
  try {
    await fs.mkdir(logsDir, { recursive: true });
    await fs.appendFile(
      path.join(logsDir, 'debug_log.txt'),
      `[${new Date().toISOString()}] [remarketing_ig] ${msg}\n`,
    );
  } catch (_) {}
}

// Mismas configs que usan la Responses API en el flujo de kanban.
function usaResponsesApi(id_configuracion) {
  return [10].includes(Number(id_configuracion));
}

// ─────────────────────────────────────────────────────────────
// programarRemarketingIG
// Agenda un remarketing de IG para el estado actual del cliente.
// v1: solo método IA. Si la config del estado no es IA, se omite.
// ─────────────────────────────────────────────────────────────
async function programarRemarketingIG({
  id_configuracion,
  id_cliente, // id del contacto (clientes_chat_center.id, propietario=0)
  page_id,
  external_id, // IGSID del cliente
  estado_contacto,
}) {
  try {
    if (!page_id || !external_id) {
      await log(`⚠️ Falta page_id/external_id — no se programa (cliente=${id_cliente})`);
      return;
    }

    // Cliente con remarketing desactivado → no programar.
    const [cli] = await db.query(
      `SELECT enviar_remarketing FROM clientes_chat_center WHERE id = ? LIMIT 1`,
      { replacements: [id_cliente], type: db.QueryTypes.SELECT },
    );
    if (cli && Number(cli.enviar_remarketing) === 0) {
      await log(`🚫 SKIP — cliente=${id_cliente} tiene enviar_remarketing=0`);
      return;
    }

    // Config del estado (secuencia 1).
    const [configRM] = await db.query(
      `SELECT tiempo_espera_horas, tiempo_espera_minutos, estado_destino,
              metodo_dentro_24h, prompt_ia
         FROM configuracion_remarketing
        WHERE id_configuracion = ? AND estado_contacto = ?
          AND secuencia = 1 AND activo = 1
        LIMIT 1`,
      {
        replacements: [id_configuracion, estado_contacto],
        type: db.QueryTypes.SELECT,
      },
    );

    if (!configRM) {
      await log(
        `ℹ️ Sin configuracion_remarketing (estado="${estado_contacto}", config=${id_configuracion}, secuencia=1, activo=1) — no se programa`,
      );
      return;
    }

    // v1 IG: solo método IA.
    if (configRM.metodo_dentro_24h !== 'ia' || !configRM.prompt_ia) {
      await log(
        `ℹ️ Estado="${estado_contacto}" no es IA (metodo=${configRM.metodo_dentro_24h}) — IG v1 solo IA, se omite`,
      );
      return;
    }

    // Cancelar pendientes IG previos de este cliente.
    await db.query(
      `UPDATE remarketing_pendientes
          SET cancelado = 1
        WHERE id_cliente_chat_center = ?
          AND id_configuracion = ?
          AND source = 'ig'
          AND enviado = 0
          AND cancelado = 0`,
      {
        replacements: [id_cliente, id_configuracion],
        type: db.QueryTypes.UPDATE,
      },
    );

    const minutos =
      configRM.tiempo_espera_minutos != null
        ? Number(configRM.tiempo_espera_minutos)
        : Number(configRM.tiempo_espera_horas || 0) * 60;

    const tiempoDisparo = new Date(Date.now() + minutos * 60 * 1000);

    await db.query(
      `INSERT INTO remarketing_pendientes
        (telefono, id_cliente_chat_center, id_configuracion,
         source, page_id, external_id,
         estado_contacto_origen, estado_destino, tiempo_disparo,
         metodo_dentro_24h, prompt_ia,
         enviado, cancelado, secuencia)
       VALUES (?, ?, ?, 'ig', ?, ?, ?, ?, ?, 'ia', ?, 0, 0, 1)`,
      {
        replacements: [
          String(external_id).slice(0, 20), // telefono es NOT NULL; guardamos el IGSID
          id_cliente,
          id_configuracion,
          page_id,
          external_id,
          estado_contacto,
          configRM.estado_destino || null,
          tiempoDisparo,
          configRM.prompt_ia,
        ],
        type: db.QueryTypes.INSERT,
      },
    );

    await log(
      `📅 Remarketing IG programado en ${minutos}min — estado=${estado_contacto} cliente=${id_cliente}`,
    );
  } catch (err) {
    await log(`❌ Error programando remarketing IG: ${err.message}`);
  }
}

// ─────────────────────────────────────────────────────────────
// generarRemarketingIgIA
// Genera el texto de reenganche con el asistente del estado.
// Soporta Responses API (config 10) y Assistants API (threads).
// Devuelve string (puede lanzar en caso de error).
// ─────────────────────────────────────────────────────────────
async function generarRemarketingIgIA({
  id_configuracion,
  id_cliente,
  estado,
  prompt_ia,
  api_key_openai,
}) {
  const {
    ejecutarAsistente,
    ejecutarConResponsesAPI,
  } = require('./kanban_ia.service');

  const [col] = await db.query(
    `SELECT id, assistant_id, instrucciones, modelo, max_tokens, vector_store_id
       FROM kanban_columnas
      WHERE id_configuracion = ?
        AND LOWER(estado_db) = LOWER(?)
        AND activo = 1
      LIMIT 1`,
    { replacements: [id_configuracion, estado], type: db.QueryTypes.SELECT },
  );

  if (!col || !col.assistant_id) {
    throw new Error(`Sin columna/assistant para estado="${estado}"`);
  }

  const triggerMsg =
    '[ACCIÓN INTERNA: GENERAR_REMARKETING] Sigue ESTRICTAMENTE las instrucciones de remarketing indicadas. NO saludes de nuevo, NO te presentes, NO preguntes ciudad ni datos como si fuera un primer contacto. Devuelve ÚNICAMENTE el mensaje de reenganche según el ángulo indicado.';

  if (usaResponsesApi(id_configuracion)) {
    const previous_response_id = await obtenerUltimoResponseId(id_cliente);
    const r = await ejecutarConResponsesAPI({
      previous_response_id,
      instructions: col.instrucciones || '',
      additional_instructions: prompt_ia || null,
      input: triggerMsg,
      model: col.modelo || 'gpt-4o-mini',
      max_tokens: col.max_tokens || 300,
      vector_store_id: col.vector_store_id || null,
      api_key_openai,
    });
    // NO guardamos el response_id del remarketing: evita inflar la cadena de la
    // conversación con los nudges + el mensaje-trigger interno (lo que llevaba a
    // context_length_exceeded). El remarketing SÍ lee el contexto vía
    // previous_response_id, pero el próximo mensaje real del cliente encadena
    // desde su última respuesta real, no desde los remarketings.
    return (r?.respuesta || '').trim();
  }

  // Assistants API (threads)
  const {
    obtenerOCrearThreadId,
  } = require('./obtener_thread.service');
  const id_thread = await obtenerOCrearThreadId(id_cliente, api_key_openai);
  if (!id_thread) throw new Error('Cliente sin thread de OpenAI');

  const headers = {
    Authorization: `Bearer ${api_key_openai}`,
    'Content-Type': 'application/json',
    'OpenAI-Beta': 'assistants=v2',
  };

  const r = await ejecutarAsistente({
    id_thread,
    assistant_id: col.assistant_id,
    mensaje: triggerMsg,
    max_tokens: col.max_tokens || 300,
    headers,
    skip_send_message: false,
    additional_instructions: prompt_ia || null,
  });

  return (r?.respuesta || '').trim();
}

module.exports = {
  programarRemarketingIG,
  generarRemarketingIgIA,
  log,
  usaResponsesApi,
};
