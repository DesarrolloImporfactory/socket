const { db } = require('../database/config');
const { ensureUnifiedClient } = require('../utils/unified/ensureUnifiedClient');

/** -----------------------------
 * Helpers
 * ------------------------------*/

async function getConfigOwner(id_configuracion) {
  const [row] = await db.query(
    `SELECT id_usuario, id_plataforma, nombre_configuracion
     FROM configuraciones
     WHERE id = ? AND suspendido = 0
     LIMIT 1`,
    { replacements: [id_configuracion], type: db.QueryTypes.SELECT },
  );
  return row || null;
}

/**
 * Nombre “bonito” del propietario:
 * 1) Para MS/IG: page_name desde messenger_pages si existe
 * 2) nombre_configuracion desde configuraciones si existe
 * 3) 'NEGOCIO'
 */
async function resolveOwnerDisplayName({ id_configuracion, page_id }) {
  // 1) Nombre real de la página (MS/IG)
  if (page_id) {
    const [p] = await db.query(
      `SELECT page_name
       FROM messenger_pages
       WHERE page_id = ? AND status='active'
       LIMIT 1`,
      { replacements: [String(page_id)], type: db.QueryTypes.SELECT },
    );
    if (p?.page_name && String(p.page_name).trim()) {
      return String(p.page_name).trim();
    }
  }

  // 2) Nombre de configuración
  const [c] = await db.query(
    `SELECT nombre_configuracion
     FROM configuraciones
     WHERE id = ? LIMIT 1`,
    { replacements: [id_configuracion], type: db.QueryTypes.SELECT },
  );

  if (c?.nombre_configuracion && String(c.nombre_configuracion).trim()) {
    return String(c.nombre_configuracion).trim();
  }

  return 'NEGOCIO';
}

/**
 * ✅ DUEÑO ÚNICO por configuración:
 * - Busca por (id_configuracion, propietario=1) SIN depender de source/page_id
 * - Si no existe, lo crea una sola vez.
 */
async function getOwnerClientId({ id_configuracion, id_plataforma, page_id }) {
  // 1) Buscar dueño global por configuración
  const [owner] = await db.query(
    `SELECT id, id_encargado, id_departamento, nombre_cliente
     FROM clientes_chat_center
     WHERE id_configuracion = ?
       AND propietario = 1
       AND deleted_at IS NULL
     LIMIT 1`,
    {
      replacements: [id_configuracion],
      type: db.QueryTypes.SELECT,
    },
  );

  // 2) Si existe, actualizar nombre si está vacío/NEGOCIO
  if (owner?.id) {
    const current = (owner.nombre_cliente || '').trim();
    if (!current || current.toUpperCase() === 'NEGOCIO') {
      const displayName = await resolveOwnerDisplayName({
        id_configuracion,
        page_id,
      });

      await db.query(
        `UPDATE clientes_chat_center
         SET nombre_cliente = ?, updated_at = NOW()
         WHERE id = ?`,
        { replacements: [displayName, owner.id] },
      );

      owner.nombre_cliente = displayName;
    }
    return owner;
  }

  // 3) Crear dueño único
  const displayName = await resolveOwnerDisplayName({
    id_configuracion,
    page_id,
  });

  const [ins] = await db.query(
    `INSERT INTO clientes_chat_center
      (id_configuracion, id_plataforma, propietario,
       nombre_cliente, apellido_cliente, source,
       created_at, updated_at)
     VALUES
      (?, ?, 1, ?, '', 'owner', NOW(), NOW())`,
    {
      replacements: [id_configuracion, id_plataforma ?? null, displayName],
      type: db.QueryTypes.INSERT,
    },
  );

  const insertedId = ins?.insertId ?? ins;

  const [finalOwner] = await db.query(
    `SELECT id, id_encargado, id_departamento, nombre_cliente
     FROM clientes_chat_center
     WHERE id = ? LIMIT 1`,
    { replacements: [insertedId], type: db.QueryTypes.SELECT },
  );

  return finalOwner || null;
}

/** -----------------------------
 * Core: ensureUnifiedConversation
 * ------------------------------*/

/**
 * ✅ Conversación unificada:
 * - contacto (propietario=0) por canal:
 *    - WA: ensureUnifiedClient por celular_cliente (internamente)
 *    - MS/IG: ensureUnifiedClient por (source, page_id, external_id)
 * - dueño (propietario=1) global por id_configuracion
 *
 * Devuelve:
 *  - id_cliente = dueño (alias compatible)
 *  - id_cliente_dueno
 *  - id_cliente_contacto
 *  - id_encargado / id_departamento (del contacto por RR)
 */
async function ensureUnifiedConversation({
  id_configuracion,
  source = 'ms', // 'wa' | 'ms' | 'ig'
  page_id = null, // ms/ig page id
  external_id = null, // ms/ig psid/igsid, wa: phone
  customer_name = '',
}) {
  const cfgOwner = await getConfigOwner(id_configuracion);
  if (!cfgOwner) return null;

  // 1) CONTACTO (propietario=0)
  const contacto = await ensureUnifiedClient({
    id_configuracion,
    id_usuario_dueno: cfgOwner.id_usuario,
    id_plataforma: cfgOwner.id_plataforma,

    source,
    business_phone_id: page_id,
    page_id,
    external_id,

    // Para WA el ensureUnifiedClient usa celular real (phone)
    phone: source === 'wa' ? String(external_id || '') : external_id,

    nombre_cliente: customer_name || '',
    apellido_cliente: '',
    motivo: `auto_round_robin_${source}`,
  });

  if (!contacto?.id) return null;

  // 2) DUEÑO ÚNICO por configuración
  const owner = await getOwnerClientId({
    id_configuracion,
    id_plataforma: cfgOwner.id_plataforma,
    page_id, // solo para nombre bonito si aplica
  });

  if (!owner?.id) return null;

  // 3) Devolver IDs consistentes
  return {
    id_cliente: owner.id, // ✅ alias compatible con code viejo
    id_cliente_dueno: owner.id,
    id_cliente_contacto: contacto.id,
    id_encargado: contacto.id_encargado ?? null,
    id_departamento: contacto.id_departamento ?? null,
  };
}

/** -----------------------------
 * Save messages
 * ------------------------------*/

/**
 * Guardar mensaje ENTRANTE (user -> negocio)
 * id_cliente = dueño
 * celular_recibe = contacto
 */
async function saveIncomingMessageUnified({
  id_configuracion,
  id_plataforma = null,
  id_cliente, // dueño
  celular_recibe = null, // contacto
  source = 'ms',
  page_id = null,
  external_id = null,

  mid = null,
  text = null,
  attachments = null,
  postback_payload = null,
  quick_reply_payload = null, // (no usado en insert, pero lo dejamos por compatibilidad)
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
      (id_plataforma, id_configuracion, id_cliente, celular_recibe, source, page_id,
       mid_mensaje, external_mid, tipo_mensaje, rol_mensaje, direction,
       status_unificado, texto_mensaje, uid_whatsapp,
       attachments_unificado, meta_unificado, created_at, updated_at, visto)
     VALUES
      (?, ?, ?, ?, ?, ?,
       ?, ?, ?, 0, 'in',
       ?, ?, ?,
       ?, ?, NOW(), NOW(), 0)`,
    {
      replacements: [
        id_plataforma,
        id_configuracion,
        id_cliente,
        celular_recibe,
        source,
        page_id,

        mid,
        external_mid,
        tipo_mensaje,

        status_unificado,
        texto_mensaje,
        external_id, // PSID/IGSID o phone WA

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
 * Guardar mensaje SALIENTE (negocio -> user)
 * id_cliente = dueño
 * celular_recibe = contacto
 */
async function saveOutgoingMessageUnified({
  id_configuracion,
  id_plataforma = null,
  id_cliente, // dueño
  celular_recibe = null, // contacto
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
      (id_plataforma, id_configuracion, id_cliente, celular_recibe, source, page_id,
       mid_mensaje, external_mid, tipo_mensaje, rol_mensaje, direction,
       status_unificado, texto_mensaje, uid_whatsapp, responsable,
       attachments_unificado, meta_unificado, created_at, updated_at, visto)
     VALUES
      (?, ?, ?, ?, ?, ?,
       ?, ?, ?, 1, 'out',
       ?, ?, ?, ?,
       ?, ?, NOW(), NOW(), 1)`,
    {
      // ✅ FIX: replacements en orden correcto (incluye celular_recibe)
      replacements: [
        id_plataforma,
        id_configuracion,
        id_cliente,
        celular_recibe,
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

/** -----------------------------
 * Delivery / Read
 * ------------------------------*/

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

async function markReadUnified({
  id_configuracion,
  source = 'ms',
  page_id,
  external_id,
  watermark,
  id_cliente,
}) {
  // 1) marcar OUT como read
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
  // helpers
  getConfigOwner,
  resolveOwnerDisplayName,
  getOwnerClientId,

  // core
  ensureUnifiedConversation,

  // messages
  saveIncomingMessageUnified,
  saveOutgoingMessageUnified,

  // states
  markDeliveredUnified,
  markReadUnified,
};
