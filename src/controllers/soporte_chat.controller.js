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
 * El frontend envía `kb_type` ("dropi" | "plataforma") para indicar cuál usar.
 * Si no se envía, se auto-detecta con un mini-prompt de clasificación.
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

/**
 * GET /soporte_chat/check_dropi?id_configuracion=XX
 */
const checkDropi = async (req, res) => {
  try {
    const { id_configuracion } = req.query;

    if (!id_configuracion) {
      return res.json({ hasDropi: false });
    }

    const [rows] = await db.query(
      `SELECT COUNT(*) as cnt 
       FROM dropi_integrations 
       WHERE id_configuracion = :idc 
         AND is_active = 1 
         AND deleted_at IS NULL`,
      {
        replacements: { idc: id_configuracion },
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
 * Clasifica la consulta del usuario como "dropi" o "plataforma"
 * usando un mini-prompt al modelo.
 */
async function classifyQuery(apiKey, userMessage) {
  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
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
 * POST /soporte_chat/ask
 * Body: { id_configuracion, messages, tema_context, has_dropi, kb_type }
 *
 * kb_type: "dropi" | "plataforma" | "auto"
 *   - "dropi": usa KB transportadoras
 *   - "plataforma": usa KB plataforma
 *   - "auto" o null: clasifica automáticamente con el router
 */
const ask = async (req, res) => {
  try {
    const { id_configuracion, messages, tema_context, has_dropi, kb_type } =
      req.body;

    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ message: 'No se recibieron mensajes.' });
    }

    // ─── Obtener api_key_openai del cliente ───
    let apiKey = null;

    if (id_configuracion) {
      const [config] = await db.query(
        `SELECT c.api_key_openai
         FROM configuraciones c
         WHERE c.id = :idc
         LIMIT 1`,
        {
          replacements: { idc: id_configuracion },
          type: Sequelize.QueryTypes.SELECT,
        },
      );

      apiKey = config?.api_key_openai || null;
    }

    if (!apiKey) {
      const id_usuario = req.user?.id_usuario;
      if (id_usuario) {
        const [userConf] = await db.query(
          `SELECT c.api_key_openai
           FROM configuraciones c
           JOIN configuraciones_usuario cu ON cu.id_configuracion = c.id_configuracion
           WHERE cu.id_usuario = :idu
             AND c.api_key_openai IS NOT NULL
             AND c.api_key_openai != ''
           LIMIT 1`,
          {
            replacements: { idu: id_usuario },
            type: Sequelize.QueryTypes.SELECT,
          },
        );
        apiKey = userConf?.api_key_openai || null;
      }
    }

    if (!apiKey) {
      // Fallback: usar API key del sistema para soporte
      apiKey = process.env.OPENAI_API_KEY || null;
    }

    if (!apiKey) {
      return res.status(400).json({
        message:
          'El asistente de soporte no está disponible en este momento. Contacta soporte por WhatsApp al +593 99 897 9214.',
      });
    }

    // ─── Determinar qué KB usar ───
    let resolvedKbType = kb_type || 'auto';

    // Si es "auto", clasificar con el router
    if (resolvedKbType === 'auto') {
      const lastUserMsg = [...messages]
        .reverse()
        .find((m) => m.role === 'user');
      if (lastUserMsg) {
        const classified = await classifyQuery(apiKey, lastUserMsg.content);
        if (classified) {
          resolvedKbType = classified;
        } else {
          // Fallback: si tiene Dropi y el tema es Dropi, usa dropi; sino plataforma
          resolvedKbType = has_dropi ? 'dropi' : 'plataforma';
        }
      } else {
        resolvedKbType = has_dropi ? 'dropi' : 'plataforma';
      }
    }

    // ─── Armar system prompt ───
    let systemPrompt;

    if (resolvedKbType === 'dropi' && KB_TRANSPORTADORAS) {
      systemPrompt =
        SYSTEM_PROMPT_DROPI +
        '\n\n--- BASE DE CONOCIMIENTO ---\n\n' +
        KB_TRANSPORTADORAS;
    } else if (resolvedKbType === 'plataforma' && KB_PLATAFORMA) {
      systemPrompt =
        SYSTEM_PROMPT_PLATAFORMA +
        '\n\n--- BASE DE CONOCIMIENTO ---\n\n' +
        KB_PLATAFORMA;
    } else if (has_dropi && KB_TRANSPORTADORAS) {
      // Fallback si no hay KB de plataforma
      systemPrompt =
        SYSTEM_PROMPT_DROPI +
        '\n\n--- BASE DE CONOCIMIENTO ---\n\n' +
        KB_TRANSPORTADORAS;
    } else if (KB_PLATAFORMA) {
      systemPrompt =
        SYSTEM_PROMPT_PLATAFORMA +
        '\n\n--- BASE DE CONOCIMIENTO ---\n\n' +
        KB_PLATAFORMA;
    } else {
      systemPrompt = SYSTEM_PROMPT_PLATAFORMA;
    }

    // Agregar contexto del tema si existe
    if (tema_context) {
      systemPrompt += `\n\nContexto de la consulta: ${tema_context}`;
    }

    // ─── Armar mensajes para OpenAI ───
    const openaiMessages = [
      { role: 'system', content: systemPrompt },
      ...messages.slice(-10).map((m) => ({
        role: m.role === 'assistant' ? 'assistant' : 'user',
        content: m.content,
      })),
    ];

    // ─── Llamar a OpenAI ───
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: openaiMessages,
        max_tokens: 600,
        temperature: 0.4,
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
      kb_used: resolvedKbType, // informar al frontend qué KB se usó
    });
  } catch (err) {
    console.error('[SoporteChat] ask error:', err.message);
    return res.status(500).json({
      message: 'Error interno del asistente de soporte.',
    });
  }
};

module.exports = { checkDropi, ask };
