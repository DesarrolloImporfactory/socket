const { db } = require('../database/config');

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
       (id_configuracion, page_id, igsid, status, unread_count, first_contact_at, last_message_at)
     VALUES (?, ?, ?, 'open', 0, NOW(), NOW())`,
    {
      replacements: [id_configuracion, page_id, igsid],
      type: db.QueryTypes.INSERT,
    }
  );
  return ins?.insertId ?? ins;
}

async function saveIncomingMessage({
  id_configuracion,
  page_id,
  igsid,
  text,
  attachments = null,
  mid = null,
  meta = null,
}) {
  const conversation_id = await ensureConversation({
    id_configuracion,
    page_id,
    igsid,
  });

  const [ins] = await db.query(
    `INSERT INTO instagram_messages
      (conversation_id, id_configuracion, page_id, igsid, direction, mid, text, attachments, status, meta, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'in', ?, ?, ?, 'received', ?, NOW(), NOW())`,
    {
      replacements: [
        conversation_id,
        id_configuracion,
        page_id,
        igsid,
        mid || null,
        text || null,
        attachments ? JSON.stringify(attachments) : null,
        meta ? JSON.stringify(meta) : null,
      ],
      type: db.QueryTypes.INSERT,
    }
  );

  await db.query(
    `UPDATE instagram_conversations
      SET last_message_at = NOW(), last_incoming_at = NOW(), unread_count = unread_count + 1
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

  const [ins] = await db.query(
    `INSERT INTO instagram_messages
      (conversation_id, id_configuracion, page_id, igsid, direction, mid, text, attachments, status, meta, created_at, updated_at, id_encargado)
     VALUES (?, ?, ?, ?, 'out', ?, ?, ?, ?, ?, NOW(), NOW(), ?)`,
    {
      replacements: [
        conversation_id,
        id_configuracion,
        page_id,
        igsid,
        mid || null,
        text || null,
        attachments ? JSON.stringify(attachments) : null,
        status,
        meta ? JSON.stringify(meta) : null,
        id_encargado,
      ],
      type: db.QueryTypes.INSERT,
    }
  );

  await db.query(
    `UPDATE instagram_conversations
      SET last_message_at = NOW(), last_outgoing_at = NOW()
     WHERE id = ?`,
    { replacements: [conversation_id] }
  );

  const insertedId = ins?.insertId ?? ins;
  const [row] = await db.query(
    `SELECT id, created_at FROM instagram_messages WHERE id=? LIMIT 1`,
    { replacements: [insertedId], type: db.QueryTypes.SELECT }
  );

  return { conversation_id, message_id: row.id, created_at: row.created_at };
}

// Opcionales (IG no envía delivery/read igual que Messenger; puedes extender si lo necesitas)
async function markDelivered(/* { page_id, watermark, mids=[] } */) {}
async function markRead({ id_configuracion, page_id, igsid }) {
  await db.query(
    `UPDATE instagram_conversations
        SET unread_count = 0, updated_at = NOW()
      WHERE id_configuracion=? AND page_id=? AND igsid=?`,
    { replacements: [id_configuracion, page_id, igsid] }
  );
}

module.exports = {
  ensureConversation,
  saveIncomingMessage,
  saveOutgoingMessage,
  markDelivered,
  markRead,
};
