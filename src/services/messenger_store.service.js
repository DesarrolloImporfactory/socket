const { db } = require('../database/config');

async function ensureConversation({
  id_configuracion,
  page_id,
  psid,
  customer_name = null,
}) {
  const [row] = await db.query(
    `SELECT id FROM messenger_conversations
     WHERE id_configuracion = ? AND page_id = ? AND psid = ? LIMIT 1`,
    {
      replacements: [id_configuracion, page_id, psid],
      type: db.QueryTypes.SELECT,
    }
  );
  if (row) return row.id;

  const [ins] = await db.query(
    `INSERT INTO messenger_conversations
      (id_configuracion, page_id, psid, status, unread_count, first_contact_at, last_message_at)
     VALUES (?, ?, ?, 'open', 0, NOW(), NOW())`,
    {
      replacements: [id_configuracion, page_id, psid],
      type: db.QueryTypes.INSERT,
    }
  );

  // compatibilidad por si el driver devuelve el id directo o como insertId
  const conversationId = ins?.insertId ?? ins;
  return conversationId;
}

async function saveIncomingMessage({
  id_configuracion,
  page_id,
  psid,
  text,
  attachments = null,
  postback_payload = null,
  quick_reply_payload = null,
  sticker_id = null,
  mid = null,
  meta = null,
}) {
  const conversation_id = await ensureConversation({
    id_configuracion,
    page_id,
    psid,
  });

  const [ins] = await db.query(
    `INSERT INTO messenger_messages
      (conversation_id, id_configuracion, page_id, psid, direction, mid, text, attachments,
       postback_payload, quick_reply_payload, sticker_id, status, meta, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'in', ?, ?, ?, ?, ?, ?, 'received', ?, NOW(), NOW())`,
    {
      replacements: [
        conversation_id,
        id_configuracion,
        page_id,
        psid,
        mid || null,
        text || null,
        attachments ? JSON.stringify(attachments) : null,
        postback_payload || null,
        quick_reply_payload || null,
        sticker_id || null,
        meta ? JSON.stringify(meta) : null,
      ],
      type: db.QueryTypes.INSERT,
    }
  );

  await db.query(
    `UPDATE messenger_conversations
     SET last_message_at = NOW(),
         last_incoming_at = NOW(),
         unread_count = unread_count + 1
     WHERE id = ?`,
    { replacements: [conversation_id] }
  );

  const insertedId = ins?.insertId ?? ins;
  const [row] = await db.query(
    `SELECT id, created_at FROM messenger_messages WHERE id = ? LIMIT 1`,
    { replacements: [insertedId], type: db.QueryTypes.SELECT }
  );

  return { conversation_id, id: row.id, created_at: row.created_at };
}

async function saveOutgoingMessage({
  id_configuracion,
  page_id,
  psid,
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
    psid,
  });

  const [ins] = await db.query(
    `INSERT INTO messenger_messages
      (conversation_id, id_configuracion, page_id, psid, direction, mid, text, attachments,
       status, meta, created_at, updated_at, id_encargado)
     VALUES (?, ?, ?, ?, 'out', ?, ?, ?, ?, ?, NOW(), NOW(), ?)`,
    {
      replacements: [
        conversation_id,
        id_configuracion,
        page_id,
        psid,
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
    `UPDATE messenger_conversations
     SET last_message_at = NOW(),
         last_outgoing_at = NOW()
     WHERE id = ?`,
    { replacements: [conversation_id] }
  );

  const insertedId = ins?.insertId ?? ins;
  const [row] = await db.query(
    `SELECT id, created_at FROM messenger_messages WHERE id = ? LIMIT 1`,
    { replacements: [insertedId], type: db.QueryTypes.SELECT }
  );

  return { conversation_id, id: row.id, created_at: row.created_at };
}

// Llega delivery: { watermark, mids[]? }
async function markDelivered({ page_id, watermark, mids = [] }) {
  if (mids && mids.length) {
    await db.query(
      `UPDATE messenger_messages
       SET status = CASE WHEN status IN ('sent','queued') THEN 'delivered' ELSE status END,
           delivery_watermark = ?
       WHERE page_id = ? AND mid IN (${mids.map(() => '?').join(',')})`,
      { replacements: [watermark, page_id, ...mids] }
    );
  } else {
    // Sin mids: marcar por watermark (todo lo anterior como delivered)
    await db.query(
      `UPDATE messenger_messages
       SET status = CASE WHEN status IN ('sent','queued') THEN 'delivered' ELSE status END,
           delivery_watermark = ?
       WHERE page_id = ? AND direction='out' AND created_at <= FROM_UNIXTIME(?/1000)`,
      { replacements: [watermark, page_id, watermark] }
    );
  }
}

// Llega read: { watermark }
async function markRead({ id_configuracion, page_id, psid, watermark }) {
  // 1) Marcar como "read" los OUT enviados a ese PSID antes del watermark
  await db.query(
    `UPDATE messenger_messages
       SET status = CASE
           WHEN status IN ('delivered','sent') THEN 'read'
           ELSE status
         END,
         read_watermark = ?
     WHERE id_configuracion = ?
       AND page_id = ?
       AND psid = ?
       AND direction = 'out'
       AND created_at <= FROM_UNIXTIME(?/1000)`,
    { replacements: [watermark, id_configuracion, page_id, psid, watermark] }
  );

  // 2) Resetear los no leídos SOLO de esa conversación
  await db.query(
    `UPDATE messenger_conversations
        SET unread_count = 0, updated_at = NOW()
      WHERE id_configuracion = ?
        AND page_id = ?
        AND psid = ?`,
    { replacements: [id_configuracion, page_id, psid] }
  );
}

async function touchConversationOnOutgoing({
  id_configuracion,
  page_id,
  psid,
  now = new Date(),
}) {
  await db.query(
    `UPDATE messenger_conversations
     SET last_message_at = ?, last_outgoing_at = ?, updated_at = ?
     WHERE id_configuracion = ? AND page_id = ? AND psid = ?`,
    {
      replacements: [now, now, now, id_configuracion, page_id, psid],
    }
  );
}

module.exports = {
  ensureConversation,
  saveIncomingMessage,
  saveOutgoingMessage,
  markDelivered,
  markRead,
  touchConversationOnOutgoing,
};
