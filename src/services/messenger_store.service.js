// services/messenger_store.service.js
const { db } = require('../database/config');

async function ensureConversation({
  id_configuracion,
  page_id,
  psid,
  customer_name = null,
}) {
  // ¿ya existe?
  const [row] = await db.query(
    `SELECT id FROM messenger_conversations
     WHERE id_configuracion = ? AND page_id = ? AND psid = ? LIMIT 1`,
    {
      replacements: [id_configuracion, page_id, psid],
      type: db.QueryTypes.SELECT,
    }
  );
  if (row) return row.id;

  // crear
  const [ins] = await db.query(
    `INSERT INTO messenger_conversations
      (id_configuracion, page_id, psid, status, unread_count, first_contact_at, last_message_at)
     VALUES (?, ?, ?, 'open', 0, NOW(), NOW())`,
    {
      replacements: [id_configuracion, page_id, psid],
      type: db.QueryTypes.INSERT,
    }
  );
  return ins;
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
    }
  );

  // actualizar counters/fechas conversación
  await db.query(
    `UPDATE messenger_conversations
     SET last_message_at = NOW(),
         last_incoming_at = NOW(),
         unread_count = unread_count + 1
     WHERE id = ?`,
    { replacements: [conversation_id] }
  );

  return { conversation_id, message_id: ins.insertId };
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
}) {
  const conversation_id = await ensureConversation({
    id_configuracion,
    page_id,
    psid,
  });

  const [ins] = await db.query(
    `INSERT INTO messenger_messages
      (conversation_id, id_configuracion, page_id, psid, direction, mid, text, attachments,
       status, meta, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'out', ?, ?, ?, ?, ?, NOW(), NOW())`,
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
      ],
    }
  );

  await db.query(
    `UPDATE messenger_conversations
     SET last_message_at = NOW(),
         last_outgoing_at = NOW()
     WHERE id = ?`,
    { replacements: [conversation_id] }
  );

  return { conversation_id, message_id: ins.insertId };
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
async function markRead({ page_id, watermark }) {
  await db.query(
    `UPDATE messenger_messages
     SET status = CASE
         WHEN status IN ('delivered','sent') THEN 'read'
         ELSE status
       END,
       read_watermark = ?
     WHERE page_id = ? AND direction='out' AND created_at <= FROM_UNIXTIME(?/1000)`,
    { replacements: [watermark, page_id, watermark] }
  );

  // reset de no leídos en conversación
  await db.query(
    `UPDATE messenger_conversations
     SET unread_count = 0
     WHERE page_id = ?`,
    { replacements: [page_id] }
  );
}

module.exports = {
  ensureConversation,
  saveIncomingMessage,
  saveOutgoingMessage,
  markDelivered,
  markRead,
};
