/**
 * webhook_contactos.controller.js
 *
 * Sistema Centralizado de Encuestas - IMPORCHAT
 *
 * POST /api/v1/webhook_contactos/inbound
 *   → Recibe respuestas de formularios externos (webhook_lead)
 *   → Busca encuesta activa por webhook_secret o id_configuracion
 *   → Busca/crea cliente en clientes_chat_center (scoped por id_configuracion)
 *   → Asigna encargado vía ROUND ROBIN (reutiliza lógica existente)
 *   → Guarda respuesta en encuestas_respuestas
 *   → Envía mensaje de bienvenida:
 *        - Dentro 24h → texto libre (ChatService.sendMessage)
 *        - Fuera 24h  → template de Meta (con o sin variables)
 */

const { db } = require('../database/config');
const { QueryTypes } = require('sequelize');
const ChatService = require('../services/chat.service');
const whatsappService = require('../services/whatsapp.service');

const { ensureUnifiedClient } = require('../utils/unified/ensureUnifiedClient');
const {
  asignarRoundRobinClienteExistente,
} = require('../utils/webhook_whatsapp/round_robin');

exports.inbound_trive = async (req, res) => {
  const ts = new Date().toISOString();

  console.log(`[trive ${ts}] HEADERS:`, JSON.stringify(req.headers));
  console.log(`[trive ${ts}] BODY:`, JSON.stringify(req.body));
  console.log(`[trive ${ts}] QUERY:`, JSON.stringify(req.query));

  try {
    const ip =
      req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
      req.socket?.remoteAddress ||
      null;

    const [insertId] = await db.query(
      `INSERT INTO webhook_trive_eventos
        (raw_headers, raw_body, raw_query, http_method, ip, user_agent, status)
       VALUES (:hdrs, :body, :query, :method, :ip, :ua, 'received')`,
      {
        replacements: {
          hdrs: JSON.stringify(req.headers || {}),
          body: JSON.stringify(req.body || {}),
          query: JSON.stringify(req.query || {}),
          method: req.method || null,
          ip,
          ua: req.headers['user-agent'] || null,
        },
        type: QueryTypes.INSERT,
      },
    );

    console.log(`[trive] ✅ Evento almacenado: id=${insertId}`);

    return res.status(200).json({
      ok: true,
      audit_id: insertId,
      received: true,
    });
  } catch (err) {
    console.error('[trive] ❌ Error guardando evento:', err);
    // Aún si falla la BD, respondemos 200 para que Trive no reintente infinito
    // (puedes cambiar a 500 si quieres que reintente)
    return res.status(200).json({
      ok: false,
      error: 'storage_failed',
      message: err.message,
    });
  }
};
