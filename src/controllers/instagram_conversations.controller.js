const { db } = require('../database/config');

function mapConvRowToSidebar(r) {
  const name = r.customer_name || `Instagram • ${String(r.igsid).slice(-6)}`;
  return {
    id: r.id,
    source: 'ig',
    mensaje_created_at: r.last_message_at,
    texto_mensaje: r.preview || '',
    celular_cliente: r.igsid,
    mensajes_pendientes: r.unread_count || 0,
    visto: 0,
    nombre_cliente: name,
    profile_pic_url: r.profile_pic_url || null,
    id_encargado: r.id_encargado ?? null,
    page_id: r.page_id,
    igsid: r.igsid,
    last_incoming_at: r.last_incoming_at,
    last_outgoing_at: r.last_outgoing_at,
    status: r.status,
    etiquetas: [],
    transporte: null,
    estado_factura: null,
    novedad_info: null,
  };
}

function mapMsgRowToUI(m) {
  // Normaliza attachments (igual que Messenger)
  let a0 = null;
  if (m.attachments) {
    try {
      const atts =
        typeof m.attachments === 'string'
          ? JSON.parse(m.attachments)
          : m.attachments;
      a0 = Array.isArray(atts) ? atts[0] : atts;
    } catch (_) {
      a0 = null;
    }
  }
  let tipo_mensaje = 'text';
  let ruta_archivo = null;

  if (a0) {
    const mime = String(a0.mimeType || '').toLowerCase();
    const declared = String(a0.type || a0.kind || '').toLowerCase();
    const url = a0.url || a0.ruta || '';
    const name = a0.name || a0.nombre || url.split('/').pop() || '';
    const size = Number(a0.size || 0);

    let tipo = declared;
    if (!tipo) {
      if (mime.startsWith('image/')) tipo = 'image';
      else if (mime.startsWith('video/')) tipo = 'video';
      else if (mime.startsWith('audio/')) tipo = 'audio';
      else tipo = 'document';
    }

    if (!declared && !mime && url) {
      const ext = (url.split('.').pop() || '').toLowerCase();
      if (
        ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'heic', 'svg'].includes(
          ext
        )
      )
        tipo = 'image';
      else if (['mp4', 'mov', 'avi', 'webm', 'mkv'].includes(ext))
        tipo = 'video';
      else if (['mp3', 'aac', 'wav', 'm4a', 'ogg', 'oga'].includes(ext))
        tipo = 'audio';
      else tipo = 'document';
    }

    tipo_mensaje = tipo;
    ruta_archivo =
      tipo === 'document'
        ? JSON.stringify({ ruta: url, nombre: name, size, mimeType: mime })
        : url;
  }

  const isOut = m.direction === 'out';
  const agentId = m.id_encargado ?? null;
  const responsable = isOut ? m.responsable || 'Página' : '';

  return {
    id: m.id,
    rol_mensaje: isOut ? 1 : 0,
    texto_mensaje: m.text || '',
    tipo_mensaje,
    ruta_archivo,
    mid_mensaje: m.mid || null,
    visto: m.status === 'read' ? 1 : 0,
    created_at: m.created_at,
    agent_id: isOut ? agentId : null,
    responsable,
  };
}

exports.listConversations = async (req, res) => {
  try {
    const id_configuracion = Number(req.query.id_configuracion);
    const limit = Math.min(Number(req.query.limit) || 50, 100);
    const offset = Number(req.query.offset) || 0;
    if (!id_configuracion) {
      return res
        .status(400)
        .json({ ok: false, message: 'id_configuracion requerido' });
    }

    const rows = await db.query(
      `
      SELECT c.id, c.id_configuracion, c.page_id, c.igsid,
             c.last_message_at, c.last_incoming_at, c.last_outgoing_at,
             c.unread_count, c.status,
             c.id_encargado, c.id_departamento, c.customer_name, c.profile_pic_url,
             (SELECT im.text
                FROM instagram_messages im
               WHERE im.conversation_id = c.id
               ORDER BY im.created_at DESC
               LIMIT 1) AS preview
        FROM instagram_conversations c
       WHERE c.id_configuracion = ?
       ORDER BY c.last_message_at DESC
       LIMIT ? OFFSET ?
      `,
      {
        replacements: [id_configuracion, limit, offset],
        type: db.QueryTypes.SELECT,
      }
    );

    const items = rows.map(mapConvRowToSidebar);
    res.json({ ok: true, items, limit, offset });
  } catch (e) {
    console.error('[IG listConversations]', e);
    res
      .status(500)
      .json({ ok: false, message: 'Error listando conversaciones' });
  }
};

exports.listMessages = async (req, res) => {
  try {
    const conversation_id = Number(req.params.id);
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const before_id = req.query.before_id ? Number(req.query.before_id) : null;

    if (!conversation_id) {
      return res
        .status(400)
        .json({ ok: false, message: 'conversation_id requerido' });
    }

    let rows;
    if (before_id) {
      const [anchor] = await db.query(
        `SELECT created_at FROM instagram_messages WHERE id = ? LIMIT 1`,
        { replacements: [before_id], type: db.QueryTypes.SELECT }
      );
      const anchorTs = anchor?.created_at;
      if (!anchorTs)
        return res.json({ ok: true, items: [], limit, next_before_id: null });

      rows = await db.query(
        `
         SELECT m.id, m.conversation_id, m.id_configuracion, m.page_id, m.igsid,
                m.direction, m.mid, m.text, m.attachments, m.status, m.created_at,
                m.id_encargado, su.usuario AS responsable
           FROM instagram_messages m
      LEFT JOIN sub_usuarios_chat_center su ON su.id_sub_usuario = m.id_encargado
          WHERE m.conversation_id = ?
            AND (
              m.created_at < ?
              OR (m.created_at = ? AND m.id < ?)
            )
       ORDER BY m.created_at DESC, m.id DESC
          LIMIT ?`,
        {
          replacements: [conversation_id, anchorTs, anchorTs, before_id, limit],
          type: db.QueryTypes.SELECT,
        }
      );
    } else {
      rows = await db.query(
        `
         SELECT m.id, m.conversation_id, m.id_configuracion, m.page_id, m.igsid,
                m.direction, m.mid, m.text, m.attachments, m.status, m.created_at,
                m.id_encargado, su.usuario AS responsable
           FROM instagram_messages m
      LEFT JOIN sub_usuarios_chat_center su ON su.id_sub_usuario = m.id_encargado
          WHERE m.conversation_id = ?
       ORDER BY m.created_at DESC, m.id DESC
          LIMIT ?`,
        { replacements: [conversation_id, limit], type: db.QueryTypes.SELECT }
      );
    }

    const asc = rows.slice().reverse();
    const items = asc.map(mapMsgRowToUI);
    const next_before_id = items.length ? items[0].id : null;
    res.json({ ok: true, items, limit, next_before_id });
  } catch (e) {
    console.error('[IG listMessages]', e);
    res.status(500).json({ ok: false, message: 'Error listando mensajes' });
  }
};
