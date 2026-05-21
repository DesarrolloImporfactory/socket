// services/kanban_ia_v2.service.js
// ─────────────────────────────────────────────────────────────
// Version 2 del procesador de mensajes Kanban con IA.
//
// Diferencia clave vs V1 (kanban_ia.service.js):
//   - V1: el modelo devuelve texto con tags inline (`[generar_guia]:true`)
//         y el codigo parsea con regex + .includes().
//   - V2: el modelo devuelve JSON garantizado por el schema
//         (response_format: json_schema, strict: true) y el codigo
//         despacha acciones leyendo campos tipados.
//
// Activacion: opt-in por columna. Solo se usa V2 si existe un
// registro activo en `kanban_columnas_v2_schemas` para la columna.
// Si no, el caller debe seguir usando V1.
// ─────────────────────────────────────────────────────────────

const axios = require('axios');
const path = require('path');
const fs = require('fs').promises;
const { db } = require('../database/config');

const {
  enviarMensajeWhatsapp,
} = require('../utils/webhook_whatsapp/enviarMensajes');
const {
  enviarMedioWhatsapp,
} = require('../utils/webhook_whatsapp/enviarMultimedia');
const { obtenerOCrearThreadId } = require('./obtener_thread.service');

const logsDir = path.join(process.cwd(), './src/logs/logs_meta');

async function log(msg) {
  await fs.mkdir(logsDir, { recursive: true });
  await fs.appendFile(
    path.join(logsDir, 'debug_log.txt'),
    `[${new Date().toISOString()}] [kanban_ia_v2] ${msg}\n`,
  );
}

function esSinSaldo(err) {
  const status = err?.response?.status;
  const code = err?.response?.data?.error?.code;
  const msg = err?.response?.data?.error?.message || '';
  return (
    (status === 429 && code === 'insufficient_quota') ||
    status === 402 ||
    msg.toLowerCase().includes('exceeded your current quota') ||
    msg.toLowerCase().includes('insufficient_quota')
  );
}

async function marcarOpenAIInactivo(id_configuracion, motivo) {
  try {
    await db.query(
      `UPDATE configuraciones
       SET openai_activo = 0,
           openai_error_at = NOW(),
           openai_error_msg = ?
       WHERE id = ?`,
      {
        replacements: [
          motivo?.slice(0, 500) || 'Error desconocido',
          id_configuracion,
        ],
        type: db.QueryTypes.UPDATE,
      },
    );
  } catch (err) {
    await log(`No se pudo marcar openai_activo=0: ${err.message}`);
  }
}

async function marcarOpenAIActivo(id_configuracion) {
  try {
    await db.query(
      `UPDATE configuraciones
       SET openai_activo = 1,
           openai_error_at = NULL,
           openai_error_msg = NULL
       WHERE id = ? AND openai_activo = 0`,
      {
        replacements: [id_configuracion],
        type: db.QueryTypes.UPDATE,
      },
    );
  } catch (err) {
    await log(`No se pudo marcar openai_activo=1: ${err.message}`);
  }
}

// ─────────────────────────────────────────────────────────────
// cargarConfigV2
// Carga la configuracion V2 (schema + mapa de acciones) para una columna.
// Devuelve null si la columna no esta opt-in a V2.
// ─────────────────────────────────────────────────────────────
async function cargarConfigV2(id_kanban_columna) {
  const [row] = await db.query(
    `SELECT response_schema, accion_map, modelo
     FROM   kanban_columnas_v2_schemas
     WHERE  id_kanban_columna = ? AND activo = 1
     LIMIT  1`,
    {
      replacements: [id_kanban_columna],
      type: db.QueryTypes.SELECT,
    },
  );

  if (!row?.response_schema) return null;

  const parseJson = (val) => {
    if (!val) return null;
    if (typeof val !== 'string') return val;
    try {
      return JSON.parse(val);
    } catch {
      return null;
    }
  };

  return {
    response_schema: parseJson(row.response_schema),
    accion_map: parseJson(row.accion_map) || {},
    modelo: row.modelo || null,
  };
}

// ─────────────────────────────────────────────────────────────
// procesarMensajeKanbanV2
// Mismo contrato que procesarMensajeKanban (V1) pero usa structured
// outputs. Si la columna no esta opt-in a V2, devuelve sin_config_v2
// y el caller debe fallback a V1.
// ─────────────────────────────────────────────────────────────
async function procesarMensajeKanbanV2(params) {
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

  // 1. Columna activa
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
    await log(`Sin columna para estado=${estado_contacto} config=${id_configuracion}`);
    return { ok: false, motivo: 'sin_columna' };
  }

  if (!columna.activa_ia || !columna.assistant_id) {
    return { ok: false, motivo: 'ia_inactiva' };
  }

  // 2. Config V2 (schema + accion_map)
  const cfgV2 = await cargarConfigV2(columna.id);
  if (!cfgV2 || !cfgV2.response_schema) {
    return { ok: false, motivo: 'sin_config_v2' };
  }

  // 3. Thread del cliente
  const id_thread = await obtenerOCrearThreadId(id_cliente, api_key_openai);
  if (!id_thread) {
    await log(`No se pudo obtener thread para id_cliente=${id_cliente}`);
    return { ok: false, motivo: 'sin_thread' };
  }

  const headers = {
    Authorization: `Bearer ${api_key_openai}`,
    'Content-Type': 'application/json',
    'OpenAI-Beta': 'assistants=v2',
  };

  // 4. Enviar mensaje del usuario al thread
  await axios
    .post(
      `https://api.openai.com/v1/threads/${id_thread}/messages`,
      { role: 'user', content: mensaje },
      { headers },
    )
    .catch(async (err) => log(`Error enviando mensaje: ${err.message}`));

  // 5. Ejecutar asistente con response_format json_schema
  let resultado;
  try {
    resultado = await ejecutarAsistenteEstructurado({
      id_thread,
      assistant_id: columna.assistant_id,
      max_tokens: columna.max_tokens || 500,
      headers,
      response_format: {
        type: 'json_schema',
        json_schema: cfgV2.response_schema,
      },
      modelo_override: cfgV2.modelo,
    });
  } catch (err) {
    if (err.code === 'sin_saldo_openai') {
      await log(`SIN SALDO OPENAI para config=${id_configuracion}`);
      await marcarOpenAIInactivo(
        id_configuracion,
        err?.response?.data?.error?.message || 'Sin saldo OpenAI',
      );
      return { ok: false, motivo: 'sin_saldo_openai' };
    }
    if (err.code === 'json_invalido') {
      await log(`JSON invalido del modelo. raw=${err.raw?.slice(0, 500)}`);
      return { ok: false, motivo: 'json_invalido', raw: err.raw };
    }
    throw err;
  }

  if (!resultado || !resultado.data) {
    return { ok: false, motivo: 'sin_respuesta_asistente' };
  }

  const data = resultado.data;
  const total_tokens = resultado.total_tokens || 0;

  await log(
    `Respuesta V2 columna="${columna.nombre}":\n${JSON.stringify(data, null, 2)}`,
  );

  // 6. Despachar acciones segun el JSON tipado
  await dispatchAccionesEstructuradas({
    data,
    columna,
    accion_map: cfgV2.accion_map,
    id_cliente,
    id_configuracion,
    telefono,
    business_phone_id,
    accessToken,
    total_tokens,
  });

  await marcarOpenAIActivo(id_configuracion);

  return {
    ok: true,
    via: 'v2',
    respuesta_enviada: data.respuesta_usuario || '',
    accion: data.accion || null,
    total_tokens,
  };
}

// ─────────────────────────────────────────────────────────────
// ejecutarAsistenteEstructurado
// Crea un run en Assistants API v2 con response_format json_schema.
// Hace polling y devuelve el JSON ya parseado.
// ─────────────────────────────────────────────────────────────
async function ejecutarAsistenteEstructurado({
  id_thread,
  assistant_id,
  max_tokens = 500,
  headers,
  response_format,
  modelo_override = null,
}) {
  try {
    const body = {
      assistant_id,
      max_completion_tokens: max_tokens,
      response_format,
    };
    if (modelo_override) body.model = modelo_override;

    const runRes = await axios.post(
      `https://api.openai.com/v1/threads/${id_thread}/runs`,
      body,
      { headers },
    );
    const run_id = runRes?.data?.id;
    if (!run_id) throw new Error('No se pudo crear run');

    let statusRun = 'queued';
    let attempts = 0;
    let total_tokens = 0;

    while (
      statusRun !== 'completed' &&
      statusRun !== 'failed' &&
      attempts < 25
    ) {
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
        throw new Error(`Run fallo: ${JSON.stringify(lastErr)}`);
      }
    }

    if (statusRun !== 'completed') {
      throw new Error(`Run no completo (status=${statusRun})`);
    }

    // Recuperar el ultimo mensaje del asistente para este run
    const messagesRes = await axios.get(
      `https://api.openai.com/v1/threads/${id_thread}/messages`,
      { headers },
    );
    const mensajes = messagesRes.data.data || [];
    const textBlock = mensajes
      .reverse()
      .find((m) => m.role === 'assistant' && m.run_id === run_id)
      ?.content?.[0]?.text;

    const raw = (textBlock?.value || '').trim();

    let data;
    try {
      data = JSON.parse(raw);
    } catch (parseErr) {
      const e = new Error('json_invalido');
      e.code = 'json_invalido';
      e.raw = raw;
      throw e;
    }

    return { data, total_tokens, raw };
  } catch (err) {
    if (esSinSaldo(err)) {
      await log(
        `SIN SALDO OPENAI: ${err?.response?.data?.error?.message || err.message}`,
      );
      const e = new Error('sin_saldo_openai');
      e.code = 'sin_saldo_openai';
      throw e;
    }
    throw err;
  }
}

// ─────────────────────────────────────────────────────────────
// dispatchAccionesEstructuradas
// Despacha las acciones a partir del JSON tipado. Cero parsing de
// texto: cada decision viene de un campo del objeto data.
// ─────────────────────────────────────────────────────────────
async function dispatchAccionesEstructuradas({
  data,
  columna,
  accion_map,
  id_cliente,
  id_configuracion,
  telefono,
  business_phone_id,
  accessToken,
  total_tokens,
}) {
  const responsable = `IA_V2_${columna.nombre}`;

  // a) Cambiar estado segun data.accion (mapeado por accion_map)
  if (data.accion && data.accion !== 'ninguna') {
    const estadoDestino = accion_map?.[data.accion];
    if (estadoDestino) {
      await db.query(
        `UPDATE clientes_chat_center SET estado_contacto = ? WHERE id = ?`,
        {
          replacements: [estadoDestino, id_cliente],
          type: db.QueryTypes.UPDATE,
        },
      );
      await log(
        `Estado -> "${estadoDestino}" (accion=${data.accion}, cliente=${id_cliente})`,
      );
    } else {
      await log(
        `accion="${data.accion}" sin mapeo en accion_map de columna=${columna.id}`,
      );
    }
  }

  // b) Persistir pedido si vino (traceabilidad)
  if (data.pedido && typeof data.pedido === 'object') {
    try {
      await db.query(
        `INSERT INTO kanban_pedidos_v2
           (id_kanban_columna, id_cliente, id_configuracion, accion, pedido_json, created_at)
         VALUES (?, ?, ?, ?, ?, NOW())`,
        {
          replacements: [
            columna.id,
            id_cliente,
            id_configuracion,
            data.accion || 'ninguna',
            JSON.stringify(data.pedido),
          ],
          type: db.QueryTypes.INSERT,
        },
      );
    } catch (err) {
      await log(`No se pudo persistir pedido_v2: ${err.message}`);
    }
  }

  // c) Enviar media (array tipado, cero regex)
  if (Array.isArray(data.media)) {
    for (const m of data.media) {
      if (!m?.url || !m?.tipo) continue;
      const tipoWa = m.tipo === 'imagen' ? 'image' : 'video';
      await enviarMedioWhatsapp({
        tipo: tipoWa,
        url_archivo: m.url,
        phone_whatsapp_to: telefono,
        business_phone_id,
        accessToken,
        id_configuracion,
        responsable,
      }).catch(async (err) =>
        log(`Error enviando ${m.tipo} url=${m.url}: ${err.message}`),
      );
    }
  }

  // d) Enviar texto (ya viene limpio, sin tags ni URLs)
  if (data.respuesta_usuario && data.respuesta_usuario.trim()) {
    await enviarMensajeWhatsapp({
      phone_whatsapp_to: telefono,
      texto_mensaje: data.respuesta_usuario.trim(),
      business_phone_id,
      accessToken,
      id_configuracion,
      responsable,
      total_tokens,
    });
  }
}

module.exports = {
  procesarMensajeKanbanV2,
  cargarConfigV2,
};
