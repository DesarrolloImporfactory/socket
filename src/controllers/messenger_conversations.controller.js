const { db } = require('../database/config');

function prettyNameFromPsid(psid = '') {
  const s = String(psid || '');
  return s ? `Facebook • ${s.slice(-6)}` : 'Facebook';
}

function mapMsgRowToUI(m) {
  // 1) Normaliza attachments (puede venir string/obj/array)
  let a0 = null;
  if (m.attachments) {
    try {
      const atts =
        typeof m.attachments === 'string'
          ? JSON.parse(m.attachments)
          : m.attachments;
      a0 = Array.isArray(atts) ? atts[0] : atts;
    } catch (_) {
      // si no se puede parsear, lo tratamos como documento genérico abajo
      a0 = null;
    }
  }

  // 2) Deducir tipo y ruta_archivo
  let tipo_mensaje = 'text';
  let ruta_archivo = null;

  if (a0) {
    const mime = String(a0.mimeType || '').toLowerCase();
    const declared = String(a0.type || a0.kind || '').toLowerCase();
    const url = a0.url || a0.ruta || '';
    const name = a0.name || a0.nombre || url.split('/').pop() || '';
    const size = Number(a0.size || 0);

    // prioridad: tipo declarado -> mime -> extensión
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

    // UI:
    // - image/video/audio => string (URL directa)
    // - document => JSON.stringify({ ruta, nombre, size, mimeType })
    if (tipo === 'document') {
      ruta_archivo = JSON.stringify({
        ruta: url,
        nombre: name,
        size,
        mimeType: mime,
      });
    } else {
      ruta_archivo = url;
    }
  }

  // 3) Responsable / agente
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
      SELECT c.id, c.id_configuracion, c.page_id, c.psid,
             c.last_message_at, c.last_incoming_at, c.last_outgoing_at,
             c.unread_count, c.status,
             c.id_encargado, c.id_departamento, c.customer_name, c.profile_pic_url,
             (SELECT mm.text
                FROM messenger_messages mm
               WHERE mm.conversation_id = c.id
               ORDER BY mm.created_at DESC
               LIMIT 1) AS preview
        FROM messenger_conversations c
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
    console.error('[MS listConversations]', e);
    res
      .status(500)
      .json({ ok: false, message: 'Error listando conversaciones' });
  }
};

function mapConvRowToSidebar(r) {
  return {
    id: r.id,
    source: 'ms',
    mensaje_created_at: r.last_message_at,
    texto_mensaje: r.preview || '',
    celular_cliente: r.psid,
    mensajes_pendientes: r.unread_count || 0,
    visto: 0,
    nombre_cliente: r.customer_name || `Facebook • ${String(r.psid).slice(-6)}`,
    profile_pic_url: r.profile_pic_url || null,
    id_encargado: r.id_encargado ?? null,
    page_id: r.page_id,
    psid: r.psid,
    last_incoming_at: r.last_incoming_at,
    last_outgoing_at: r.last_outgoing_at,
    status: r.status,
    etiquetas: [],
    transporte: null,
    estado_factura: null,
    novedad_info: null,
  };
}

// controllers/messenger.js (o donde definas este handler)

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

    // --- helpers locales (mismos que usamos para IG, adaptados a MS) ---
    const parseAttachments = (attStr) => {
      if (!attStr) return [];
      try {
        const v = typeof attStr === 'string' ? JSON.parse(attStr) : attStr;
        return Array.isArray(v) ? v : [];
      } catch {
        return [];
      }
    };

    const mapMsgRowToUI = (row) => {
      // direction: "in" -> 0 (entrante), "out" -> 1 (saliente)
      const rol_mensaje = row.direction === 'out' ? 1 : 0;

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

      // Normalizar el PRIMER attachment
      const atts = parseAttachments(row.attachments);
      if (atts.length > 0) {
        const a0 = atts[0] || {};
        const t = String(a0.type || '').toLowerCase();
        const payload = a0.payload || {};
        const url =
          a0.url || payload.url || payload.preview_url || payload.src || null;

        if (t === 'image') {
          return { ...base, tipo_mensaje: 'image', ruta_archivo: url || '' };
        }

        if (t === 'video') {
          return { ...base, tipo_mensaje: 'video', ruta_archivo: url || '' };
        }

        if (t === 'audio') {
          return { ...base, tipo_mensaje: 'audio', ruta_archivo: url || '' };
        }

        if (t === 'sticker') {
          return { ...base, tipo_mensaje: 'sticker', ruta_archivo: url || '' };
        }

        // Messenger suele mandar archivos genéricos como "file"
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

        // Ubicación (si tu backend guarda coordinates en payload)
        if (t === 'location' && (payload.latitude || payload.lat)) {
          const latitude = payload.latitude ?? payload.lat;
          const longitude =
            payload.longitude ?? payload.lng ?? payload.longitud ?? null;
          return {
            ...base,
            tipo_mensaje: 'location',
            texto_mensaje: JSON.stringify({ latitude, longitude }),
            ruta_archivo: null,
          };
        }
      }

      return base;
    };

    // --- consulta principal ---
    let rows;
    if (before_id) {
      // anchor para paginar hacia atrás
      const [anchor] = await db.query(
        `SELECT created_at FROM messenger_messages WHERE id = ? LIMIT 1`,
        { replacements: [before_id], type: db.QueryTypes.SELECT }
      );
      const anchorTs = anchor?.created_at;

      if (!anchorTs) {
        return res.json({ ok: true, items: [], limit, next_before_id: null });
      }

      rows = await db.query(
        `
         SELECT m.id, m.conversation_id, m.id_configuracion, m.page_id, m.psid,
                m.direction, m.mid, m.text, m.attachments, m.status, m.created_at,
                m.id_encargado, su.usuario AS responsable
           FROM messenger_messages m
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
      // primer page (más recientes)
      rows = await db.query(
        `
         SELECT m.id, m.conversation_id, m.id_configuracion, m.page_id, m.psid,
                m.direction, m.mid, m.text, m.attachments, m.status, m.created_at,
                m.id_encargado, su.usuario AS responsable
           FROM messenger_messages m
      LEFT JOIN sub_usuarios_chat_center su ON su.id_sub_usuario = m.id_encargado
          WHERE m.conversation_id = ?
       ORDER BY m.created_at DESC, m.id DESC
          LIMIT ?`,
        { replacements: [conversation_id, limit], type: db.QueryTypes.SELECT }
      );
    }

    // de DESC a ASC para la UI
    const asc = rows.slice().reverse();
    const items = asc.map(mapMsgRowToUI);

    // cursor = id del más antiguo del batch actual
    const next_before_id = items.length ? items[0].id : null;

    res.json({ ok: true, items, limit, next_before_id });
  } catch (e) {
    console.error('[MS listMessages]', e);
    res.status(500).json({ ok: false, message: 'Error listando mensajes' });
  }
};
