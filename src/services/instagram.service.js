const { db } = require('../database/config');

function extractText(event) {
  return event.message?.text || null;
}
function extractAttachments(event) {
  const atts = event.message?.attachments || [];
  if (!atts.length) return null;
  return JSON.stringify(
    atts.map((a) => ({
      type: a.type,
      url: a.payload?.url || null,
      payload: a.payload || null,
    }))
  );
}

async function findConnectionByPage(pageId) {
  const [[row]] = await db.query(
    'SELECT * FROM instagram_pages WHERE page_id = ? AND status = "active" LIMIT 1',
    [pageId]
  );
  return row || null;
}

async function upsertConversation({ id_configuracion, page_id, igsid, now }) {
  // ¿existe?
  const [[conv]] = await db.query(
    'SELECT * FROM instagram_conversations WHERE id_configuracion = ? AND page_id = ? AND igsid = ? LIMIT 1',
    [id_configuracion, page_id, igsid]
  );
  if (conv) return conv;

  // crear
  const insert = `
    INSERT INTO instagram_conversations
      (id_configuracion, page_id, igsid, status, unread_count,
       first_contact_at, last_message_at, last_incoming_at, updated_at)
    VALUES (?, ?, ?, 'open', 0, ?, ?, ?, NOW())
  `;
  const [res] = await db.query(insert, [
    id_configuracion,
    page_id,
    igsid,
    now,
    now,
    now,
  ]);
  const [[created]] = await db.query(
    'SELECT * FROM instagram_conversations WHERE id = ?',
    [res.insertId]
  );
  return created;
}

async function touchConversationOnIncoming(conversation_id, now) {
  await db.query(
    `UPDATE instagram_conversations
     SET last_message_at = ?, last_incoming_at = ?, updated_at = NOW()
     WHERE id = ?`,
    [now, now, conversation_id]
  );
}

module.exports = {
  /**
   * Rutea un evento (mensajes entrantes)
   * body.entry[].messaging[] con:
   *  - sender.id (IGSID del usuario)
   *  - recipient.id (PAGE_ID)
   *  - message.mid, message.text, attachments, is_echo, etc.
   */
  async routeEvent(event) {
    // ignorar echos (mensajes que enviaste tú)
    if (event.message?.is_echo) return;

    const pageId = event.recipient?.id;
    const igsid = event.sender?.id;
    const mid = event.message?.mid;
    if (!pageId || !igsid || !mid) return;

    const conn = await findConnectionByPage(pageId);
    if (!conn) {
      // page no conectada en tu plataforma
      return;
    }

    const id_configuracion = conn.id_configuracion;
    const now = new Date();

    // upsert conversación
    const conv = await upsertConversation({
      id_configuracion,
      page_id: pageId,
      igsid,
      now,
    });

    // insertar mensaje
    const text = extractText(event);
    const attachments = extractAttachments(event);

    const insertMsg = `
      INSERT INTO instagram_messages
        (conversation_id, id_configuracion, page_id, igsid, direction, mid, text,
         attachments, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'in', ?, ?, ?, 'received', ?, ?)
    `;
    await db.query(insertMsg, [
      conv.id,
      id_configuracion,
      pageId,
      igsid,
      mid,
      text,
      attachments,
      now,
      now,
    ]);

    // actualizar punteros de la conversación
    await touchConversationOnIncoming(conv.id, now);

    // (opcional) emitir a sockets aquí
    // sockets.emitToConfig(id_configuracion, 'instagram:new-message', {...})
  },
};
