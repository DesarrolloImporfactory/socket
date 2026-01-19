const { db } = require('../database/config');
const { ensureUnifiedClient } = require('../utils/unified/ensureUnifiedClient');

async function getConfigOwner(id_configuracion) {
  const [row] = await db.query(
    `SELECT id_usuario, id_plataforma
     FROM configuraciones
     WHERE id = ? AND suspendido = 0
     LIMIT 1`,
    { replacements: [id_configuracion], type: db.QueryTypes.SELECT },
  );
  return row || null;
}

/**
 * Asegura cliente unificado en clientes_chat_center
 * - source: 'ms' | 'ig'
 * - page_id: page id
 * - external_id: PSID/IGSID
 *
 * Devuelve: { id_cliente, id_encargado, id_departamento }
 */
async function ensureUnifiedConversation({
  id_configuracion,
  source = 'ms',
  page_id,
  external_id,
  customer_name = '',
}) {
  const cfgOwner = await getConfigOwner(id_configuracion);
  if (!cfgOwner) return null;

  // ✅ 1) crear/obtener cliente unificado (incluye RR unificado dentro)
  const cliente = await ensureUnifiedClient({
    id_configuracion,
    id_usuario_dueno: cfgOwner.id_usuario,
    id_plataforma: cfgOwner.id_plataforma,

    source,
    business_phone_id: page_id,
    page_id,
    external_id,

    // para WA se usa phone real; aquí no aplica, pero no rompe
    phone: external_id,

    nombre_cliente: customer_name || '',
    apellido_cliente: '',

    motivo: `auto_round_robin_${source}`,
  });

  if (!cliente?.id) return null;

  // ✅ 2) NO volver a hacer RR aquí (evita pisar id_encargado)

  // Releer asignación final
  const [finalRow] = await db.query(
    `SELECT id, id_encargado, id_departamento
     FROM clientes_chat_center
     WHERE id = ? LIMIT 1`,
    { replacements: [cliente.id], type: db.QueryTypes.SELECT },
  );

  return {
    id_cliente: finalRow.id,
    id_encargado: finalRow.id_encargado ?? null,
    id_departamento: finalRow.id_departamento ?? null,
  };
}

/**
 * Guardar mensaje ENTRANTE (user -> page)
 */
async function saveIncomingMessageUnified({
  id_configuracion,
  id_plataforma = null,
  id_cliente,
  source = 'ms',
  page_id = null,
  external_id = null,

  mid = null,
  text = null,
  attachments = null,
  postback_payload = null,
  quick_reply_payload = null,
  sticker_id = null,

  meta = null,
  status_unificado = 'received',
}) {
  const external_mid = mid || null;

  const tipo_mensaje = postback_payload
    ? 'postback'
    : attachments?.length
      ? 'attachment'
      : sticker_id
        ? 'sticker'
        : 'text';

  const texto_mensaje = postback_payload
    ? `Postback: ${postback_payload}`
    : text || null;

  const attachments_unificado = attachments
    ? JSON.stringify(attachments)
    : null;

  const meta_unificado = meta ? JSON.stringify(meta) : null;

  const [ins] = await db.query(
    `INSERT INTO mensajes_clientes
      (id_plataforma, id_configuracion, id_cliente, source, page_id,
       mid_mensaje, external_mid, tipo_mensaje, rol_mensaje, direction,
       status_unificado, texto_mensaje, uid_whatsapp,
       attachments_unificado, meta_unificado, created_at, updated_at, visto)
     VALUES
      (?, ?, ?, ?, ?,
       ?, ?, ?, 0, 'in',
       ?, ?, ?,
       ?, ?, NOW(), NOW(), 0)`,
    {
      replacements: [
        id_plataforma,
        id_configuracion,
        id_cliente,
        source,
        page_id,

        mid,
        external_mid,
        tipo_mensaje,

        status_unificado,
        texto_mensaje,
        external_id, // PSID/IGSID

        attachments_unificado,
        meta_unificado,
      ],
      type: db.QueryTypes.INSERT,
    },
  );

  const insertedId = ins?.insertId ?? ins;
  const [row] = await db.query(
    `SELECT id, created_at FROM mensajes_clientes WHERE id = ? LIMIT 1`,
    { replacements: [insertedId], type: db.QueryTypes.SELECT },
  );

  return { message_id: row?.id, created_at: row?.created_at };
}

/**
 * Guardar mensaje SALIENTE (page -> user)
 */
async function saveOutgoingMessageUnified({
  id_configuracion,
  id_plataforma = null,
  id_cliente,
  source = 'ms',
  page_id = null,
  external_id = null,

  mid = null,
  text = null,
  attachments = null,

  status_unificado = 'sent',
  meta = null,
  responsable = null,
  id_encargado = null,
}) {
  const external_mid = mid || null;

  const tipo_mensaje = attachments?.length ? 'attachment' : 'text';
  const texto_mensaje = text || null;

  const attachments_unificado = attachments
    ? JSON.stringify(attachments)
    : null;

  const meta_unificado = meta ? JSON.stringify(meta) : null;

  const [ins] = await db.query(
    `INSERT INTO mensajes_clientes
      (id_plataforma, id_configuracion, id_cliente, source, page_id,
       mid_mensaje, external_mid, tipo_mensaje, rol_mensaje, direction,
       status_unificado, texto_mensaje, uid_whatsapp, responsable,
       attachments_unificado, meta_unificado, created_at, updated_at, visto)
     VALUES
      (?, ?, ?, ?, ?,
       ?, ?, ?, 1, 'out',
       ?, ?, ?, ?,
       ?, ?, NOW(), NOW(), 1)`,
    {
      replacements: [
        id_plataforma,
        id_configuracion,
        id_cliente,
        source,
        page_id,

        mid,
        external_mid,
        tipo_mensaje,

        status_unificado,
        texto_mensaje,
        external_id,
        responsable || (id_encargado ? String(id_encargado) : null),

        attachments_unificado,
        meta_unificado,
      ],
      type: db.QueryTypes.INSERT,
    },
  );

  const insertedId = ins?.insertId ?? ins;
  const [row] = await db.query(
    `SELECT id, created_at FROM mensajes_clientes WHERE id = ? LIMIT 1`,
    { replacements: [insertedId], type: db.QueryTypes.SELECT },
  );

  return { message_id: row?.id, created_at: row?.created_at };
}

/**
 * DELIVERY
 */
async function markDeliveredUnified({
  id_configuracion,
  source = 'ms',
  page_id,
  watermark,
  mids = [],
}) {
  if (mids?.length) {
    await db.query(
      `UPDATE mensajes_clientes
       SET status_unificado = CASE
          WHEN status_unificado IN ('queued','sent') THEN 'delivered'
          ELSE status_unificado
       END,
       delivery_watermark = ?
       WHERE id_configuracion = ?
         AND source = ?
         AND page_id = ?
         AND external_mid IN (${mids.map(() => '?').join(',')})`,
      { replacements: [watermark, id_configuracion, source, page_id, ...mids] },
    );
  } else {
    await db.query(
      `UPDATE mensajes_clientes
       SET status_unificado = CASE
          WHEN status_unificado IN ('queued','sent') THEN 'delivered'
          ELSE status_unificado
       END,
       delivery_watermark = ?
       WHERE id_configuracion = ?
         AND source = ?
         AND page_id = ?
         AND direction = 'out'
         AND created_at <= FROM_UNIXTIME(?/1000)`,
      {
        replacements: [watermark, id_configuracion, source, page_id, watermark],
      },
    );
  }
}

/**
 * READ (por conversación/cliente)
 */
async function markReadUnified({
  id_configuracion,
  source = 'ms',
  page_id,
  external_id,
  watermark,
  id_cliente,
}) {
  // 1) marcar OUT a read
  await db.query(
    `UPDATE mensajes_clientes
     SET status_unificado = CASE
        WHEN status_unificado IN ('delivered','sent') THEN 'read'
        ELSE status_unificado
     END,
     read_watermark = ?
     WHERE id_configuracion = ?
       AND source = ?
       AND page_id = ?
       AND uid_whatsapp = ?
       AND direction = 'out'
       AND created_at <= FROM_UNIXTIME(?/1000)`,
    {
      replacements: [
        watermark,
        id_configuracion,
        source,
        page_id,
        external_id,
        watermark,
      ],
    },
  );

  // 2) marcar IN como visto
  if (id_cliente) {
    await db.query(
      `UPDATE mensajes_clientes
       SET visto = 1
       WHERE id_cliente = ?
         AND source = ?
         AND direction = 'in'
         AND visto = 0`,
      { replacements: [id_cliente, source] },
    );
  }
}

module.exports = {
  ensureUnifiedConversation,
  saveIncomingMessageUnified,
  saveOutgoingMessageUnified,
  markDeliveredUnified,
  markReadUnified,
};
