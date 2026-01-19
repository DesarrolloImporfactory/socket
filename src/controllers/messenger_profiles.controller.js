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
      i > 0 && ex.has(w) ? w : (w[0] ? w[0].toUpperCase() : '') + w.slice(1),
    )
    .join(' ');
}

// token de la pagina por config + page_id
async function getPageAccessTokenByConfigAndPage(id_configuracion, page_id) {
  const row = await db.query(
    `SELECT page_access_token AS token
       FROM messenger_pages
      WHERE id_configuracion = ? AND page_id = ? AND status = 'active'
      LIMIT 1`,
    { replacements: [id_configuracion, page_id], type: db.QueryTypes.SELECT },
  );
  return row?.[0]?.token || null;
}

async function getUnifiedMsClient(
  id_configuracion,
  psid,
  page_id_optional = null,
) {
  // si viene page_id opcional, filtramos con el también (mas estricto)
  if (page_id_optional) {
    const rows = await db.query(
      `SELECT id, page_id, nombre_cliente, apellido_cliente, imagePath
         FROM clientes_chat_center
        WHERE id_configuracion = ?
          AND source = 'ms'
          AND page_id = ?
          AND external_id = ?
          AND deleted_at IS NULL
        LIMIT 1`,
      {
        replacements: [
          id_configuracion,
          String(page_id_optional),
          String(psid),
        ],
        type: db.QueryTypes.SELECT,
      },
    );
    return rows?.[0] || null;
  }

  // si no viene page_id, tomamos el mas reciente por psid en esa config
  const rows = await db.query(
    `SELECT id, page_id, nombre_cliente, apellido_cliente, imagePath
       FROM clientes_chat_center
      WHERE id_configuracion = ?
        AND source = 'ms'
        AND external_id = ?
        AND deleted_at IS NULL
      ORDER BY updated_at DESC
      LIMIT 1`,
    {
      replacements: [id_configuracion, String(psid)],
      type: db.QueryTypes.SELECT,
    },
  );
  return rows?.[0] || null;
}

exports.fetchAndStoreProfile = async (req, res) => {
  try {
    const { id_configuracion, psid, force, page_id } = req.body;

    if (!id_configuracion || !psid) {
      return res.status(400).json({ ok: false, message: 'Faltan parámetros' });
    }

    const client = await getUnifiedMsClient(
      id_configuracion,
      psid,
      page_id || null,
    );
    if (!client) {
      return res.status(404).json({
        ok: false,
        message:
          'Cliente no encontrado en clientes_chat_center (MS). Primero debe llegar al webhook.',
      });
    }

    const hasName =
      (client.nombre_cliente && String(client.nombre_cliente).trim() !== '') ||
      (client.apellido_cliente &&
        String(client.apellido_cliente).trim() !== '');
    const hasPic = client.imagePath && String(client.imagePath).trim() !== '';

    if (!force && hasName && hasPic) {
      return res.json({
        ok: true,
        cached: true,
        data: {
          nombre_cliente: client.nombre_cliente,
          apellido_cliente: client.apellido_cliente,
          imagePath: client.imagePath,
        },
      });
    }

    const token = await getPageAccessTokenByConfigAndPage(
      id_configuracion,
      client.page_id,
    );
    if (!token) {
      return res.status(500).json({
        ok: false,
        message:
          'No se encontró access token activo para esa página/configuración',
      });
    }

    // Graph API (Page-Scoped ID)
    const url = `https://graph.facebook.com/v21.0/${encodeURIComponent(
      psid,
    )}?fields=first_name,last_name,profile_pic&access_token=${encodeURIComponent(token)}`;

    const resp = await fetch(url);
    const data = await resp.json();

    if (!resp.ok || data.error) {
      return res.status(502).json({
        ok: false,
        message: 'Error Graph',
        error: data.error || data,
      });
    }

    const first = data.first_name || '';
    const last = data.last_name || '';
    const nombre = toTitleCaseEs(first.trim()) || '';
    const apellido = toTitleCaseEs(last.trim()) || '';
    const pic = data.profile_pic || null;

    await db.query(
      `UPDATE clientes_chat_center
          SET nombre_cliente = ?,
              apellido_cliente = ?,
              imagePath = ?,
              updated_at = NOW()
        WHERE id = ?
        LIMIT 1`,
      { replacements: [nombre, apellido, pic, client.id] },
    );

    return res.json({
      ok: true,
      cached: false,
      data: {
        nombre_cliente: nombre,
        apellido_cliente: apellido,
        imagePath: pic,
      },
    });
  } catch (e) {
    console.error('[fetchAndStoreProfile]', e);
    res.status(500).json({ ok: false, message: 'Error interno' });
  }
};

// Batch opcional: actualiza los que esten sin nombre o sin foto
exports.refreshMissing = async (req, res) => {
  try {
    const { id_configuracion, limit = 50 } = req.body;
    if (!id_configuracion) {
      return res
        .status(400)
        .json({ ok: false, message: 'Falta id_configuracion' });
    }

    const rows = await db.query(
      `SELECT id, page_id, external_id
         FROM clientes_chat_center
        WHERE id_configuracion = ?
          AND source = 'ms'
          AND deleted_at IS NULL
          AND (
            nombre_cliente IS NULL OR TRIM(nombre_cliente) = '' OR
            imagePath IS NULL OR TRIM(imagePath) = ''
          )
        ORDER BY updated_at DESC
        LIMIT ?`,
      {
        replacements: [id_configuracion, Number(limit)],
        type: db.QueryTypes.SELECT,
      },
    );

    let count = 0;

    for (const r of rows) {
      const psid = r.external_id;
      if (!psid) continue;

      try {
        const token = await getPageAccessTokenByConfigAndPage(
          id_configuracion,
          r.page_id,
        );
        if (!token) continue;

        const url = `https://graph.facebook.com/v21.0/${encodeURIComponent(
          psid,
        )}?fields=first_name,last_name,profile_pic&access_token=${encodeURIComponent(token)}`;

        const resp = await fetch(url);
        const data = await resp.json();
        if (!resp.ok || data.error) continue;

        const nombre = toTitleCaseEs((data.first_name || '').trim()) || '';
        const apellido = toTitleCaseEs((data.last_name || '').trim()) || '';
        const pic = data.profile_pic || null;

        await db.query(
          `UPDATE clientes_chat_center
              SET nombre_cliente = ?,
                  apellido_cliente = ?,
                  imagePath = ?,
                  updated_at = NOW()
            WHERE id = ? LIMIT 1`,
          { replacements: [nombre, apellido, pic, r.id] },
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
