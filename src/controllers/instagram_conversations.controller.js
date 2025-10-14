const { db } = require('../database/config');

function mapConvRowToSidebar(r) {
  const name = r.customer_name || `Instagram • ${String(r.igsid).slice(-6)}`;

  // --- parsea últimos campos ---
  let lastMeta = {};
  try {
    lastMeta =
      typeof r.last_meta === 'string'
        ? JSON.parse(r.last_meta)
        : r.last_meta || {};
  } catch {}
  let atts = [];
  try {
    const raw =
      typeof r.last_attachments === 'string'
        ? JSON.parse(r.last_attachments)
        : r.last_attachments;
    atts = Array.isArray(raw) ? raw : [];
  } catch {
    atts = [];
  }

  const text = r.last_text || '';
  const a0 = atts[0] || null;
  const isUnsupported = Boolean(lastMeta?.raw?.is_unsupported);

  // --- resolver tipo + preview label + ruta ---
  let tipo_mensaje = 'text';
  let ruta_archivo = null;
  let preview = text || '';

  if (a0) {
    const t = String(a0.type || '').toLowerCase();
    const p = a0.payload || {};
    const url = a0.url || p.url || p.preview_url || p.src || null;

    if (t === 'image') {
      tipo_mensaje = 'image';
      preview = '🖼️ Imagen';
      ruta_archivo = url || '';
    } else if (t === 'audio') {
      tipo_mensaje = 'audio';
      preview = '🎧 Audio';
      ruta_archivo = url || '';
    } else if (t === 'video') {
      tipo_mensaje = 'video';
      preview = '🎬 Video';
      ruta_archivo = url || '';
    } else if (t === 'sticker') {
      tipo_mensaje = 'sticker';
      preview = '🖼️ Sticker';
      ruta_archivo = url || '';
    } else if (t === 'location' && (p.latitude || p.lat)) {
      tipo_mensaje = 'location';
      preview = '📍 Ubicación';
      ruta_archivo = null;
    } else {
      // file/document
      tipo_mensaje = 'document';
      preview = '📄 Documento';
      ruta_archivo = JSON.stringify({
        ruta: url || '',
        nombre: a0.name || p.file_name || 'archivo',
        size: a0.size || p.size || 0,
        mimeType: a0.mimeType || p.mime_type || '',
      });
    }
  } else if (isUnsupported) {
    tipo_mensaje = 'unsupported';
    preview = '📎 Adjunto no soportado';
  } else if (!preview) {
    // sin texto ni adjunto
    preview = '(mensaje)';
  }

  return {
    id: r.id,
    source: 'ig',
    mensaje_created_at: r.last_message_at,
    texto_mensaje: preview, // 👈 ahora sale “Imagen/Audio/Documento/Ubicación”
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
    tipo_mensaje,
    ruta_archivo,
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

            -- 👇 nuevos campos para calcular preview
            (SELECT im.text
                FROM instagram_messages im
              WHERE im.conversation_id = c.id
              ORDER BY im.created_at DESC, im.id DESC
              LIMIT 1) AS last_text,
            (SELECT im.attachments
                FROM instagram_messages im
              WHERE im.conversation_id = c.id
              ORDER BY im.created_at DESC, im.id DESC
              LIMIT 1) AS last_attachments,
            (SELECT im.meta
                FROM instagram_messages im
              WHERE im.conversation_id = c.id
              ORDER BY im.created_at DESC, im.id DESC
              LIMIT 1) AS last_meta

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

    // --- helpers locales ---
    const parseJSON = (v, fallback) => {
      try {
        if (v == null) return fallback;
        return typeof v === 'string' ? JSON.parse(v) : v;
      } catch {
        return fallback;
      }
    };

    const parseAttachments = (attStr) => {
      const v = parseJSON(attStr, []);
      return Array.isArray(v) ? v : [];
    };

    const mapMsgRowToUI = (row) => {
      const rol_mensaje = row.direction === 'out' ? 1 : 0;

      // ⚠️ ahora sí llega meta e is_unsupported desde el SELECT
      const meta = parseJSON(row.meta, {});
      const isUnsupportedFlag =
        row.is_unsupported === 1 ||
        row.is_unsupported === true ||
        Boolean(meta?.raw?.is_unsupported);

      const base = {
        id: row.id,
        rol_mensaje,
        texto_mensaje: row.text || '',
        tipo_mensaje: 'text',
        ruta_archivo: null,
        mid_mensaje: row.mid || null,
        visto: row.status === 'read' ? 1 : 0,
        created_at: row.created_at,
        responsable: rol_mensaje === 1 ? row.responsable || null : '',
      };

      const atts = parseAttachments(row.attachments);

      // 1) Si hay adjuntos, mapeamos por tipo
      if (atts.length > 0) {
        const a0 = atts[0] || {};
        const t = String(a0.type || '').toLowerCase();
        const payload = a0.payload || {};
        const url =
          a0.url || payload.url || payload.preview_url || payload.src || null;

        if (t === 'image')
          return { ...base, tipo_mensaje: 'image', ruta_archivo: url || '' };
        if (t === 'video')
          return { ...base, tipo_mensaje: 'video', ruta_archivo: url || '' };
        if (t === 'audio')
          return { ...base, tipo_mensaje: 'audio', ruta_archivo: url || '' };
        if (t === 'sticker')
          return { ...base, tipo_mensaje: 'sticker', ruta_archivo: url || '' };

        if (t === 'location' && (payload.latitude || payload.lat)) {
          const latitude = payload.latitude ?? payload.lat;
          const longitude =
            payload.longitude ?? payload.lng ?? payload.longitud ?? null;
          return {
            ...base,
            tipo_mensaje: 'location',
            texto_mensaje: JSON.stringify({ latitude, longitude }),
          };
        }

        // file/document
        if (t === 'file' || t === 'document' || !t) {
          return {
            ...base,
            tipo_mensaje: 'document',
            ruta_archivo: JSON.stringify({
              ruta: url || '',
              nombre: a0.name || payload.file_name || 'archivo',
              size: a0.size || payload.size || 0,
              mimeType: a0.mimeType || payload.mime_type || '',
            }),
          };
        }
      }

      // 2) IG “unsupported”: sin adjuntos visibles y flag activo
      if (isUnsupportedFlag) {
        return {
          ...base,
          tipo_mensaje: 'unsupported',
          // si hay algún texto, lo mostramos como pista; si no, copy genérico
          texto_mensaje:
            base.texto_mensaje || 'Adjunto no soportado por Instagram.',
        };
      }

      // 3) Texto normal
      return base;
    };

    // --- consulta principal ---
    let rows;
    if (before_id) {
      const [anchor] = await db.query(
        `SELECT created_at FROM instagram_messages WHERE id = ? LIMIT 1`,
        { replacements: [before_id], type: db.QueryTypes.SELECT }
      );
      const anchorTs = anchor?.created_at;
      if (!anchorTs) {
        return res.json({ ok: true, items: [], limit, next_before_id: null });
      }

      rows = await db.query(
        `
         SELECT m.id, m.conversation_id, m.id_configuracion, m.page_id, m.igsid,
                m.direction, m.mid, m.text, m.attachments, m.is_unsupported, m.meta,
                m.status, m.created_at,
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
                m.direction, m.mid, m.text, m.attachments, m.is_unsupported, m.meta,
                m.status, m.created_at,
                m.id_encargado, su.usuario AS responsable
           FROM instagram_messages m
      LEFT JOIN sub_usuarios_chat_center su ON su.id_sub_usuario = m.id_encargado
          WHERE m.conversation_id = ?
       ORDER BY m.created_at DESC, m.id DESC
          LIMIT ?`,
        { replacements: [conversation_id, limit], type: db.QueryTypes.SELECT }
      );
    }

    // De DESC a ASC para la UI
    const asc = rows.slice().reverse();

    // Mapear cada fila al contrato del front
    const items = asc.map(mapMsgRowToUI);

    // Cursor para paginar hacia atrás (el más antiguo del batch actual)
    const next_before_id = items.length ? items[0].id : null;

    res.json({ ok: true, items, limit, next_before_id });
  } catch (e) {
    console.error('[IG listMessages]', e);
    res.status(500).json({ ok: false, message: 'Error listando mensajes' });
  }
};
