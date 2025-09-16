const { db } = require('../database/config');

function prettyNameFromPsid(psid = '') {
  const s = String(psid || '');
  return s ? `Facebook • ${s.slice(-6)}` : 'Facebook';
}

function mapMsgRowToUI(m) {
  return {
    id: m.id,
    rol_mensaje: m.direction === 'out' ? 1 : 0,
    texto_mensaje: m.text || '',
    tipo_mensaje: m.attachments ? 'attachment' : 'text',
    ruta_archivo: m.attachments ? JSON.stringify(m.attachments) : null,
    mid_mensaje: m.mid || null,
    visto: m.status === 'read' ? 1 : 0,
    created_at: m.created_at,
    responsable: m.direction === 'out' ? 'Página' : '',
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

exports.listMessages = async (req, res) => {
  try {
    const conversation_id = Number(req.params.id);
    const limit = Math.min(Number(req.query.limit) || 50, 200);

    if (!conversation_id) {
      return res
        .status(400)
        .json({ ok: false, message: 'conversation_id requerido' });
    }

    const rows = await db.query(
      `
        SELECT m.id, m.conversation_id, m.id_configuracion, m.page_id, m.psid,
             m.direction, m.mid, m.text, m.attachments, m.status, m.created_at,
             m.id_encargado,
             su.usuario AS responsable
        FROM messenger_messages m
        LEFT JOIN sub_usuarios_chat_center su ON su.id_sub_usuario = m.id_encargado
       WHERE m.conversation_id = ?
       ORDER BY m.created_at ASC
       LIMIT ?
      `,
      { replacements: [conversation_id, limit], type: db.QueryTypes.SELECT }
    );

    const items = rows.map(mapMsgRowToUI);
    res.json({ ok: true, items, limit });
  } catch (e) {
    console.error('[MS listMessages]', e);
    res.status(500).json({ ok: false, message: 'Error listando mensajes' });
  }
};
