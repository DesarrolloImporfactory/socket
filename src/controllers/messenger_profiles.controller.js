const { db } = require('../database/config');

function toTitleCaseEs(str = '') {
  const ex = new Set([
    'de',
    'del',
    'la',
    'las',
    'el',
    'los',
    'y',
    'e',
    'o',
    'u',
    'en',
    'al',
    'a',
    'con',
    'por',
    'para',
  ]);
  const words = String(str)
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ')
    .split(' ');
  return words
    .map((w, i) =>
      i > 0 && ex.has(w) ? w : (w[0] ? w[0].toUpperCase() : '') + w.slice(1)
    )
    .join(' ');
}

// obtenemos el token de la pagina
async function getPageAccessTokenByConfigAndPage(id_configuracion, page_id) {
  const row = await db.query(
    `SELECT page_access_token AS token
       FROM messenger_pages
      WHERE id_configuracion = ? AND page_id = ?
      LIMIT 1`,
    { replacements: [id_configuracion, page_id], type: db.QueryTypes.SELECT }
  );
  return row?.[0]?.token || null;
}

exports.fetchAndStoreProfile = async (req, res) => {
  try {
    const { id_configuracion, psid, force } = req.body;
    if (!id_configuracion || !psid) {
      return res.status(400).json({ ok: false, message: 'Faltan parámetros' });
    }

    const convRows = await db.query(
      `SELECT id, page_id, customer_name, profile_pic_url
         FROM messenger_conversations
        WHERE id_configuracion = ? AND psid = ?
        LIMIT 1`,
      { replacements: [id_configuracion, psid], type: db.QueryTypes.SELECT }
    );
    const conv = convRows?.[0];
    if (!conv)
      return res
        .status(404)
        .json({ ok: false, message: 'Conversación no encontrada' });

    if (!force && conv.customer_name && conv.profile_pic_url) {
      return res.json({
        ok: true,
        cached: true,
        data: {
          customer_name: conv.customer_name,
          profile_pic_url: conv.profile_pic_url,
        },
      });
    }

    const token = await getPageAccessTokenByConfigAndPage(
      id_configuracion,
      conv.page_id
    );
    if (!token)
      return res
        .status(500)
        .json({ ok: false, message: 'No se encontró access token' });

    // Graph API (Page-Scoped ID)
    const url = `https://graph.facebook.com/v21.0/${encodeURIComponent(
      psid
    )}?fields=first_name,last_name,profile_pic&access_token=${encodeURIComponent(
      token
    )}`;
    const resp = await fetch(url);
    const data = await resp.json();
    if (!resp.ok || data.error) {
      return res
        .status(502)
        .json({ ok: false, message: 'Error Graph', error: data.error || data });
    }

    const first = data.first_name || '';
    const last = data.last_name || '';
    const name = toTitleCaseEs(`${first} ${last}`.trim()) || 'Facebook';
    const pic = data.profile_pic || null;

    await db.query(
      `UPDATE messenger_conversations
          SET customer_name = ?, profile_pic_url = ?, updated_at = NOW()
        WHERE id = ?
        LIMIT 1`,
      { replacements: [name, pic, conv.id] }
    );

    return res.json({
      ok: true,
      cached: false,
      data: { customer_name: name, profile_pic_url: pic },
    });
  } catch (e) {
    console.error('[fetchAndStoreProfile]', e);
    res.status(500).json({ ok: false, message: 'Error interno' });
  }
};

// Batch opcional
exports.refreshMissing = async (req, res) => {
  try {
    const { id_configuracion, limit = 50 } = req.body;
    if (!id_configuracion)
      return res
        .status(400)
        .json({ ok: false, message: 'Falta id_configuracion' });

    const rows = await db.query(
      `SELECT id, page_id, psid
         FROM messenger_conversations
        WHERE id_configuracion = ?
          AND (customer_name IS NULL OR profile_pic_url IS NULL)
        ORDER BY last_message_at DESC
        LIMIT ?`,
      { replacements: [id_configuracion, limit], type: db.QueryTypes.SELECT }
    );

    let count = 0;
    for (const r of rows) {
      try {
        const token = await getPageAccessTokenByConfigAndPage(
          id_configuracion,
          r.page_id
        );
        if (!token) continue;

        const url = `https://graph.facebook.com/v21.0/${encodeURIComponent(
          r.psid
        )}?fields=first_name,last_name,profile_pic&access_token=${encodeURIComponent(
          token
        )}`;
        const resp = await fetch(url);
        const data = await resp.json();
        if (!resp.ok || data.error) continue;

        const name =
          toTitleCaseEs(
            `${data.first_name || ''} ${data.last_name || ''}`.trim()
          ) || 'Facebook';
        const pic = data.profile_pic || null;

        await db.query(
          `UPDATE messenger_conversations
              SET customer_name = ?, profile_pic_url = ?, updated_at = NOW()
            WHERE id = ? LIMIT 1`,
          { replacements: [name, pic, r.id] }
        );
        count++;
      } catch (_) {}
    }

    res.json({ ok: true, updated: count });
  } catch (e) {
    console.error('[refreshMissing]', e);
    res.status(500).json({ ok: false, message: 'Error interno' });
  }
};
