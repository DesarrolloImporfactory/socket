/**
 * soporte_chat.controller.js
 *
 * Endpoints para el chatbot flotante de soporte.
 * - GET  /check_dropi   → verifica si el id_configuracion tiene integración Dropi
 * - POST /ask           → envía pregunta al modelo OpenAI con knowledge base
 *
 * Soporta DOS knowledge bases:
 *   1. Transportadoras (Dropi) → knowledge_base_transportadoras.md
 *   2. Plataforma (ImporChat)  → knowledge_base_plataforma.md
 *
 * El frontend envía `kb_type` ("dropi" | "plataforma" | "auto") para indicar cuál usar.
 * En "auto": primero se intenta clasificación por palabras clave (local, 0ms, 0 costo),
 * y solo si no resuelve se cae al router de IA.
 */

const { Sequelize } = require('sequelize');
const { db } = require('../database/config');
const fs = require('fs');
const path = require('path');

// ─── Cargar knowledge bases (se leen una sola vez al iniciar) ───
let KB_TRANSPORTADORAS = '';
let KB_PLATAFORMA = '';

try {
  const kbPath = path.join(
    __dirname,
    '..',
    'knowledge',
    'knowledge_base_transportadoras.md',
  );
  KB_TRANSPORTADORAS = fs.readFileSync(kbPath, 'utf-8');
  console.log(
    `[SoporteChat] KB Transportadoras cargado: ${KB_TRANSPORTADORAS.length} chars`,
  );
} catch (err) {
  console.error(
    '[SoporteChat] No se pudo cargar KB transportadoras:',
    err.message,
  );
}

try {
  const kbPath = path.join(
    __dirname,
    '..',
    'knowledge',
    'knowledge_base_plataforma.md',
  );
  KB_PLATAFORMA = fs.readFileSync(kbPath, 'utf-8');
  console.log(
    `[SoporteChat] KB Plataforma cargado: ${KB_PLATAFORMA.length} chars`,
  );
} catch (err) {
  console.error('[SoporteChat] No se pudo cargar KB plataforma:', err.message);
}

// ─── System prompts ───

const SYSTEM_PROMPT_DROPI = `Eres un asistente de soporte del ecosistema Dropi Ecuador, integrado en la plataforma ImporChat.
Tu rol es ayudar a usuarios (dropshippers/proveedores) con consultas sobre:
- Novedades de transportadoras y cómo responderlas en Dropi
- Estados de pedidos y su significado
- Cobertura de ciudades
- Políticas de empaque, reclamos y garantías
- Uso general de la plataforma

Reglas:
1. Responde SIEMPRE en español, de forma concisa (máx 3 párrafos)
2. Sé amigable pero profesional
3. Si no tienes la respuesta exacta, dilo honestamente
4. Usa emojis moderadamente (1-2 por respuesta máx)
5. Para novedades: siempre incluye "cómo responder en Dropi" y "qué NO hacer"
6. NO inventes información que no esté en tu base de conocimiento
7. Si el usuario necesita algo que no puedes resolver, sugiérele contactar soporte
8. Usa formato Markdown para negrillas (**texto**) y listas cuando sea útil para claridad
`;

const SYSTEM_PROMPT_PLATAFORMA = `Eres un asistente de soporte de la plataforma ImporChat (chatcenter.imporfactory.app).
Tu rol es ayudar a usuarios con consultas sobre:
- Cómo conectar WhatsApp (Coexistencia y Solo API)
- Configuración de bots y agentes de IA
- Envío de mensajes masivos y plantillas
- Uso general de la plataforma (Kanban, contactos, valoraciones, remarketing)
- Problemas técnicos comunes

Reglas:
1. Responde SIEMPRE en español, de forma concisa (máx 3 párrafos)
2. Sé amigable pero profesional
3. Si no tienes la respuesta exacta, dilo honestamente y sugiere contactar soporte por WhatsApp al +593 99 897 9214
4. Usa emojis moderadamente (1-2 por respuesta máx)
5. Cuando hables de conexión WhatsApp, SIEMPRE menciona los dos métodos disponibles (Coexistencia y Solo API) y los links de video tutorial
6. NO inventes información que no esté en tu base de conocimiento
7. Si el usuario necesita ayuda técnica personalizada, sugiérele hablar con un asesor
8. Usa formato Markdown para negrillas (**texto**) y listas cuando sea útil para claridad
9. Para videos tutoriales, incluye el enlace completo
`;

const SYSTEM_PROMPT_ROUTER = `Eres un clasificador. Dada la pregunta del usuario, responde SOLO con una palabra:
- "dropi" si la pregunta es sobre transportadoras, pedidos, guías, novedades, cobertura de ciudades, empaque, reclamos, devoluciones, estados de pedido en Dropi
- "plataforma" si la pregunta es sobre la plataforma ImporChat, conexión de WhatsApp, bots, agentes IA, plantillas, mensajes masivos, configuración, planes, suscripción, usuarios

Responde SOLO "dropi" o "plataforma", nada más.`;

// ─── Límites / configuración ───
const MAX_MESSAGES_HISTORY = 10; // últimos N mensajes que se envían al modelo
const MAX_CONTENT_CHARS = 2000; // por mensaje individual
const MAX_TEMA_CONTEXT_CHARS = 500;
const OPENAI_MAX_TOKENS = 900;
const OPENAI_MODEL = 'gpt-4o-mini';
const OPENAI_TEMPERATURE = 0.4;

// ─── Helpers de sanitización ───
function toInt(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : null;
}

function safeString(v, maxChars) {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (!s) return null;
  return maxChars ? s.slice(0, maxChars) : s;
}

function sanitizeMessages(messages) {
  if (!Array.isArray(messages)) return [];
  return messages
    .filter((m) => m && typeof m === 'object')
    .map((m) => {
      const role = m.role === 'assistant' ? 'assistant' : 'user';
      const content = safeString(m.content, MAX_CONTENT_CHARS);
      return content ? { role, content } : null;
    })
    .filter(Boolean);
}

// ─── Clasificador rápido por keywords (sin llamada a OpenAI) ───
function quickClassify(text) {
  if (!text) return null;
  const t = text.toLowerCase();

  const dropiKeywords = [
    'dropi',
    'transportadora',
    'servientrega',
    'laar',
    'gintracom',
    'speed',
    'veloces',
    'tramaco',
    'novedad',
    'guía',
    'guia',
    'pedido',
    'orden',
    'estado del pedido',
    'devolución',
    'devolucion',
    'cobertura',
    'empaque',
    'empacar',
    'reclamo',
    'garantía',
    'garantia',
    'entrega',
    'courier',
    'encomienda',
    'rastreo',
    'recaudo',
    'flete',
  ];

  const plataformaKeywords = [
    'whatsapp',
    'wsp',
    'waba',
    'coexistencia',
    'api de whatsapp',
    'meta',
    'agente ia',
    'agente de ia',
    'bot',
    'plantilla',
    'template',
    'masivo',
    'masiva',
    'kanban',
    'contacto',
    'etiqueta',
    'valoración',
    'valoracion',
    'encuesta',
    'remarketing',
    'imporchat',
    'plataforma',
    'plan',
    'suscripción',
    'suscripcion',
    'factura',
    'subusuario',
    'permisos',
    'login',
    'contraseña',
    'password',
    'configurar',
    'integrar',
    'chat center',
    'chatcenter',
  ];

  let dropiHits = 0;
  let plataformaHits = 0;

  for (const k of dropiKeywords) {
    if (t.includes(k)) dropiHits++;
  }
  for (const k of plataformaKeywords) {
    if (t.includes(k)) plataformaHits++;
  }

  if (dropiHits > 0 && plataformaHits === 0) return 'dropi';
  if (plataformaHits > 0 && dropiHits === 0) return 'plataforma';
  // Empate o ambigüedad → dejar que decida el router AI
  return null;
}

// ─── Router AI (fallback cuando quickClassify no resuelve) ───
async function classifyQuery(apiKey, userMessage) {
  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT_ROUTER },
          { role: 'user', content: userMessage },
        ],
        max_tokens: 10,
        temperature: 0,
      }),
    });

    if (!response.ok) return null;

    const data = await response.json();
    const answer = (data?.choices?.[0]?.message?.content || '')
      .trim()
      .toLowerCase();

    if (answer.includes('dropi')) return 'dropi';
    if (answer.includes('plataforma')) return 'plataforma';
    return null;
  } catch {
    return null;
  }
}

/**
 * GET /soporte_chat/check_dropi?id_configuracion=XX
 */
const checkDropi = async (req, res) => {
  try {
    const idc = toInt(req.query.id_configuracion);

    if (!idc) {
      return res.json({ hasDropi: false });
    }

    const [rows] = await db.query(
      `SELECT COUNT(*) as cnt
       FROM dropi_integrations
       WHERE id_configuracion = :idc
         AND is_active = 1
         AND deleted_at IS NULL`,
      {
        replacements: { idc },
        type: Sequelize.QueryTypes.SELECT,
      },
    );

    const cnt = rows?.cnt || (Array.isArray(rows) ? rows[0]?.cnt : 0) || 0;
    return res.json({ hasDropi: Number(cnt) > 0 });
  } catch (err) {
    console.error('[SoporteChat] checkDropi error:', err.message);
    return res.json({ hasDropi: false });
  }
};

/**
 * POST /soporte_chat/ask
 * Body: { id_configuracion, messages, tema_context, has_dropi, kb_type }
 *
 * kb_type: "dropi" | "plataforma" | "auto"
 *   - "dropi": usa KB transportadoras
 *   - "plataforma": usa KB plataforma
 *   - "auto" o null: clasifica automáticamente (keywords + router IA)
 */
const ask = async (req, res) => {
  try {
    const idConf = toInt(req.body?.id_configuracion);
    const rawMessages = req.body?.messages;
    const temaContext = safeString(
      req.body?.tema_context,
      MAX_TEMA_CONTEXT_CHARS,
    );
    const hasDropi = req.body?.has_dropi === true;
    const kbType = safeString(req.body?.kb_type, 20) || 'auto';

    const messages = sanitizeMessages(rawMessages);

    if (messages.length === 0) {
      return res
        .status(400)
        .json({ message: 'No se recibieron mensajes válidos.' });
    }

    // ─── Obtener api_key_openai del cliente ───
    let apiKey = null;

    // 1) Buscar por id_configuracion (caso principal)
    if (idConf) {
      const [config] = await db.query(
        `SELECT api_key_openai
         FROM configuraciones
         WHERE id = :idc
         LIMIT 1`,
        {
          replacements: { idc: idConf },
          type: Sequelize.QueryTypes.SELECT,
        },
      );

      apiKey = config?.api_key_openai || null;
    }

    // 2) Fallback: buscar alguna configuración del usuario autenticado que tenga api_key
    if (!apiKey) {
      const id_usuario = req.user?.id_usuario;
      if (id_usuario) {
        const [userConf] = await db.query(
          `SELECT api_key_openai
           FROM configuraciones
           WHERE id_usuario = :idu
             AND api_key_openai IS NOT NULL
             AND api_key_openai != ''
           ORDER BY id DESC
           LIMIT 1`,
          {
            replacements: { idu: id_usuario },
            type: Sequelize.QueryTypes.SELECT,
          },
        );
        apiKey = userConf?.api_key_openai || null;
      }
    }

    // 3) Fallback final: API key del sistema para soporte
    if (!apiKey) {
      apiKey = process.env.OPENAI_API_KEY_SOPORTE || null;
    }

    if (!apiKey) {
      return res.status(400).json({
        message:
          'El asistente de soporte no está disponible en este momento. Contacta soporte por WhatsApp al +593 99 897 9214.',
      });
    }

    // ─── Determinar qué KB usar ───
    let resolvedKbType = kbType;

    if (resolvedKbType === 'auto') {
      const lastUserMsg = [...messages]
        .reverse()
        .find((m) => m.role === 'user');

      if (lastUserMsg) {
        // 1) Intento rápido con keywords (gratis, 0ms)
        let classified = quickClassify(lastUserMsg.content);

        // 2) Si las keywords no resolvieron, caer al router AI
        if (!classified) {
          classified = await classifyQuery(apiKey, lastUserMsg.content);
        }

        resolvedKbType = classified || (hasDropi ? 'dropi' : 'plataforma');
      } else {
        resolvedKbType = hasDropi ? 'dropi' : 'plataforma';
      }
    }

    // ─── Armar system prompt ───
    // Estrategia:
    //   - Usuario con Dropi + ambas KB disponibles → pasar AMBAS (principal según clasificación,
    //     secundaria como referencia cruzada). Esto permite responder preguntas que mezclan temas.
    //   - Usuario sin Dropi → solo KB de plataforma.
    let systemPrompt;

    if (hasDropi && KB_TRANSPORTADORAS && KB_PLATAFORMA) {
      const primarySystem =
        resolvedKbType === 'dropi'
          ? SYSTEM_PROMPT_DROPI
          : SYSTEM_PROMPT_PLATAFORMA;

      const primaryKb =
        resolvedKbType === 'dropi' ? KB_TRANSPORTADORAS : KB_PLATAFORMA;

      const secondaryKb =
        resolvedKbType === 'dropi' ? KB_PLATAFORMA : KB_TRANSPORTADORAS;

      systemPrompt =
        primarySystem +
        '\n\n--- BASE DE CONOCIMIENTO PRINCIPAL ---\n\n' +
        primaryKb +
        '\n\n--- BASE DE CONOCIMIENTO SECUNDARIA (consulta solo si la principal no tiene la respuesta) ---\n\n' +
        secondaryKb;
    } else if (resolvedKbType === 'dropi' && KB_TRANSPORTADORAS) {
      systemPrompt =
        SYSTEM_PROMPT_DROPI +
        '\n\n--- BASE DE CONOCIMIENTO ---\n\n' +
        KB_TRANSPORTADORAS;
    } else if (resolvedKbType === 'plataforma' && KB_PLATAFORMA) {
      systemPrompt =
        SYSTEM_PROMPT_PLATAFORMA +
        '\n\n--- BASE DE CONOCIMIENTO ---\n\n' +
        KB_PLATAFORMA;
    } else if (KB_PLATAFORMA) {
      systemPrompt =
        SYSTEM_PROMPT_PLATAFORMA +
        '\n\n--- BASE DE CONOCIMIENTO ---\n\n' +
        KB_PLATAFORMA;
    } else {
      systemPrompt = SYSTEM_PROMPT_PLATAFORMA;
    }

    // Agregar contexto del tema si existe (sanitizado)
    if (temaContext) {
      systemPrompt += `\n\nContexto de la consulta: ${temaContext}`;
    }

    // ─── Armar mensajes para OpenAI ───
    const openaiMessages = [
      { role: 'system', content: systemPrompt },
      ...messages.slice(-MAX_MESSAGES_HISTORY),
    ];

    // ─── Log de uso (útil para métricas) ───
    console.log(
      `[SoporteChat] ask id_conf=${idConf || '-'} kb=${resolvedKbType} has_dropi=${hasDropi} msgs=${messages.length}`,
    );

    // ─── Llamar a OpenAI ───
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        messages: openaiMessages,
        max_tokens: OPENAI_MAX_TOKENS,
        temperature: OPENAI_TEMPERATURE,
      }),
    });

    if (!response.ok) {
      const errData = await response.json().catch(() => ({}));
      const errMsg =
        errData?.error?.message || `OpenAI error: ${response.status}`;
      console.error('[SoporteChat] OpenAI error:', errMsg);

      if (response.status === 401) {
        return res.status(400).json({
          message:
            'Tu API Key de OpenAI no es válida o fue revocada. Verifica tu clave en Integraciones → Asistentes.',
        });
      }
      if (response.status === 429) {
        return res.status(429).json({
          message:
            'Se alcanzó el límite de uso de tu API Key de OpenAI. Espera un momento e intenta de nuevo.',
        });
      }

      return res.status(500).json({ message: errMsg });
    }

    const data = await response.json();
    const respuesta =
      data?.choices?.[0]?.message?.content || 'No pude generar una respuesta.';

    return res.json({
      respuesta,
      kb_used: resolvedKbType,
    });
  } catch (err) {
    console.error('[SoporteChat] ask error:', err.message);
    return res.status(500).json({
      message: 'Error interno del asistente de soporte.',
    });
  }
};

module.exports = { checkDropi, ask };
