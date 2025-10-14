/**
 * Instagram Store Service
 * -----------------------
 * Capa de persistencia para conversaciones y mensajes de Instagram.
 * - Evita duplicados en salientes usando ON DUPLICATE KEY (requiere UNIQUE(page_id, igsid, mid, direction) o similar).
 * - Expone helpers usados por el servicio principal y por sockets (markRead, findOutgoingByMid, getConversationById).
 */

const { db } = require('../database/config');

/** Garantiza que exista la conversación y retorna su id */
async function ensureConversation({ id_configuracion, page_id, igsid }) {
  const [row] = await db.query(
    `SELECT id FROM instagram_conversations
      WHERE id_configuracion=? AND page_id=? AND igsid=? LIMIT 1`,
    {
      replacements: [id_configuracion, page_id, igsid],
      type: db.QueryTypes.SELECT,
    }
  );
  if (row) return row.id;

  const [ins] = await db.query(
    `INSERT INTO instagram_conversations
       (id_configuracion, page_id, igsid, status, unread_count, first_contact_at, last_message_at, created_at, updated_at)
     VALUES (?, ?, ?, 'open', 0, NOW(), NOW(), NOW(), NOW())`,
    {
      replacements: [id_configuracion, page_id, igsid],
      type: db.QueryTypes.INSERT,
    }
  );
  return ins?.insertId ?? ins;
}

/** Inserta un mensaje ENTRANTE (direction='in') y actualiza contadores/fechas */
async function saveIncomingMessage({
  id_configuracion,
  page_id,
  igsid,
  text,
  attachments = null,
  mid = null,
  meta = null,
  is_unsupported = false,
}) {
  const conversation_id = await ensureConversation({
    id_configuracion,
    page_id,
    igsid,
  });

  const [ins] = await db.query(
    `INSERT INTO instagram_messages
      (conversation_id, id_configuracion, page_id, igsid, direction, mid, text, attachments, is_unsupported, status, meta, created_at, updated_at)
     VALUES
      (?,              ?,               ?,       ?,     'in',      ?,   ?,    ?,           ?,              'received', ?,   NOW(),    NOW())
     ON DUPLICATE KEY UPDATE
      text           = VALUES(text),
      attachments    = VALUES(attachments),
      is_unsupported = VALUES(is_unsupported),
      meta           = COALESCE(VALUES(meta), meta),
      updated_at     = NOW()
    `,
    {
      replacements: [
        conversation_id,
        id_configuracion,
        page_id,
        igsid,
        mid || null,
        text || null,
        attachments ? JSON.stringify(attachments) : null,
        is_unsupported ? 1 : 0,
        meta ? JSON.stringify(meta) : null,
      ],
      type: db.QueryTypes.INSERT,
    }
  );

  await db.query(
    `UPDATE instagram_conversations
      SET last_message_at = NOW(), last_incoming_at = NOW(), unread_count = unread_count + 1, updated_at = NOW()
     WHERE id = ?`,
    { replacements: [conversation_id] }
  );

  const insertedId = ins?.insertId ?? ins;
  const [row] = await db.query(
    `SELECT id, created_at FROM instagram_messages WHERE id = ? LIMIT 1`,
    { replacements: [insertedId], type: db.QueryTypes.SELECT }
  );

  return { conversation_id, message_id: row.id, created_at: row.created_at };
}

/**
 * Inserta/actualiza un mensaje SALIENTE (direction='out').
 * - Si la fila ya existe (por UNIQUE mid/direction), hace upsert:
 *   * fusiona meta (JSON_MERGE_PATCH) y actualiza status/text/attachments.
 */
async function saveOutgoingMessage({
  id_configuracion,
  page_id,
  igsid,
  text,
  attachments = null,
  mid = null,
  status = 'sent',
  meta = null,
  id_encargado = null,
}) {
  const conversation_id = await ensureConversation({
    id_configuracion,
    page_id,
    igsid,
  });

  const metaStr = meta ? JSON.stringify(meta) : null;
  const attStr = attachments ? JSON.stringify(attachments) : null;

  await db.query(
    `
    INSERT INTO instagram_messages
      (conversation_id, id_configuracion, page_id, igsid, direction, mid, text, attachments, status, meta, created_at, updated_at, id_encargado)
    VALUES
      (?,              ?,               ?,       ?,     'out',     ?,   ?,    ?,           ?,     ?,   NOW(),    NOW(),      ?)
    ON DUPLICATE KEY UPDATE
      text        = COALESCE(VALUES(text), text),
      attachments = COALESCE(VALUES(attachments), attachments),
      status      = VALUES(status),
      meta        = JSON_MERGE_PATCH(COALESCE(instagram_messages.meta, JSON_OBJECT()),
                                     COALESCE(VALUES(meta), JSON_OBJECT())),
      updated_at  = NOW()
    `,
    {
      replacements: [
        conversation_id,
        id_configuracion,
        page_id,
        igsid,
        mid || null,
        text || null,
        attStr,
        status,
        metaStr,
        id_encargado,
      ],
      type: db.QueryTypes.INSERT,
    }
  );

  await db.query(
    `UPDATE instagram_conversations
       SET last_message_at = NOW(), last_outgoing_at = NOW(), updated_at = NOW()
     WHERE id = ?`,
    { replacements: [conversation_id] }
  );

  const [row] = await db.query(
    `SELECT id, created_at FROM instagram_messages WHERE conversation_id=? AND mid=? AND direction='out' LIMIT 1`,
    { replacements: [conversation_id, mid || null], type: db.QueryTypes.SELECT }
  );

  return { conversation_id, message_id: row.id, created_at: row.created_at };
}

/** Marca conversación como leída (resetea unread_count) */
async function markRead({ id_configuracion, page_id, igsid }) {
  await db.query(
    `UPDATE instagram_conversations
        SET unread_count = 0, updated_at = NOW()
      WHERE id_configuracion=? AND page_id=? AND igsid=?`,
    { replacements: [id_configuracion, page_id, igsid] }
  );
}

/** Busca un saliente por mid (para unir eco y optimista en el front) */
async function findOutgoingByMid({ conversation_id, mid }) {
  const [row] = await db.query(
    `SELECT id, meta FROM instagram_messages
      WHERE conversation_id=? AND mid=? AND direction='out' LIMIT 1`,
    { replacements: [conversation_id, mid], type: db.QueryTypes.SELECT }
  );
  return row || null;
}

/** Obtiene datos básicos de una conversación por id (para sockets) */
async function getConversationById(id) {
  const [row] = await db.query(
    `SELECT id, id_configuracion, page_id, igsid
       FROM instagram_conversations
      WHERE id=? LIMIT 1`,
    { replacements: [id], type: db.QueryTypes.SELECT }
  );
  return row || null;
}

module.exports = {
  ensureConversation,
  saveIncomingMessage,
  saveOutgoingMessage,
  markDelivered: async () => {},
  markRead,
  findOutgoingByMid,
  getConversationById,
};
