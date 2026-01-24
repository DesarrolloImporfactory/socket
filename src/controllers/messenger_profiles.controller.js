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

// token de la pagina por config + page_id (soporta ms e ig)
async function getPageAccessTokenByConfigAndPage(
  id_configuracion,
  page_id,
  source = 'ms',
) {
  const src = String(source || 'ms').toLowerCase();
  const pid = String(page_id || '').trim();

  if (!id_configuracion || !pid) return null;

  if (src === 'ig') {
    const rows = await db.query(
      `SELECT page_access_token AS token
         FROM instagram_pages
        WHERE id_configuracion = ?
          AND page_id = ?
          AND status = 'active'
        LIMIT 1`,
      { replacements: [id_configuracion, pid], type: db.QueryTypes.SELECT },
    );
    return rows?.[0]?.token || null;
  }

  // Messenger/FB
  const rows = await db.query(
    `SELECT page_access_token AS token
       FROM messenger_pages
      WHERE id_configuracion = ?
        AND page_id = ?
        AND status = 'active'
      LIMIT 1`,
    { replacements: [id_configuracion, pid], type: db.QueryTypes.SELECT },
  );
  return rows?.[0]?.token || null;
}

async function getUnifiedMetaClient(
  id_configuracion,
  external_id,
  source,
  page_id_optional = null,
) {
  if (page_id_optional) {
    const rows = await db.query(
      `SELECT id, page_id, source, nombre_cliente, apellido_cliente, imagePath
       FROM clientes_chat_center
       WHERE id_configuracion = ?
         AND source = ?
         AND page_id = ?
         AND external_id = ?
         AND deleted_at IS NULL
       LIMIT 1`,
      {
        replacements: [
          id_configuracion,
          source,
          String(page_id_optional),
          String(external_id),
        ],
        type: db.QueryTypes.SELECT,
      },
    );
    return rows?.[0] || null;
  }

  const rows = await db.query(
    `SELECT id, page_id, source, nombre_cliente, apellido_cliente, imagePath
     FROM clientes_chat_center
     WHERE id_configuracion = ?
       AND source = ?
       AND external_id = ?
       AND deleted_at IS NULL
     ORDER BY updated_at DESC
     LIMIT 1`,
    {
      replacements: [id_configuracion, source, String(external_id)],
      type: db.QueryTypes.SELECT,
    },
  );
  return rows?.[0] || null;
}

exports.fetchAndStoreProfile = async (req, res) => {
  try {
    const { id_configuracion, external_id, page_id, force, source } = req.body;

    if (!id_configuracion || !external_id) {
      return res.status(400).json({ ok: false, message: 'Faltan parámetros' });
    }

    const client = await getUnifiedMetaClient(
      id_configuracion,
      external_id,
      source,
      page_id || null,
    );

    if (!client) {
      return res.status(404).json({
        ok: false,
        message:
          'Cliente no encontrado en clientes_chat_center. Primero debe llegar al webhook.',
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

    // ✅ Detectar fuente real (prioriza body.source, si no, client.source)
    const realSource = (source || client.source || '').toLowerCase();

    const token = await getPageAccessTokenByConfigAndPage(
      id_configuracion,
      client.page_id,
      realSource,
    );

    if (!token) {
      return res.status(500).json({
        ok: false,
        message:
          'No se encontró access token activo para esa página/configuración',
      });
    }

    let nombre = '';
    let apellido = '';
    let pic = null;

    if (realSource === 'ig') {
      // ✅ Instagram: name, profile_picture_url
      const url = `https://graph.facebook.com/v22.0/${encodeURIComponent(
        external_id,
      )}?fields=name,profile_pic&access_token=${encodeURIComponent(token)}`;

      const resp = await fetch(url);
      const ig = await resp.json();

      if (!resp.ok || ig.error) {
        return res.status(502).json({
          ok: false,
          message: 'Error Graph IG',
          error: ig.error || ig,
        });
      }

      nombre = toTitleCaseEs((ig.name || '').trim()) || '';
      apellido = '';
      pic = ig.profile_pic || null;
    } else {
      // ✅ Messenger (ms): first_name, last_name, picture
      const url = `https://graph.facebook.com/v22.0/${encodeURIComponent(
        external_id,
      )}?fields=first_name,last_name,picture&access_token=${encodeURIComponent(
        token,
      )}`;

      const resp = await fetch(url);
      const data = await resp.json();

      if (!resp.ok || data.error) {
        return res.status(502).json({
          ok: false,
          message: 'Error Graph',
          error: data.error || data,
        });
      }

      nombre = toTitleCaseEs((data.first_name || '').trim()) || '';
      apellido = toTitleCaseEs((data.last_name || '').trim()) || '';
      pic = data?.picture?.data?.url || null;
    }

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

        const url = `https://graph.facebook.com/v22.0/${encodeURIComponent(
          psid,
        )}?fields=first_name,last_name,picture&access_token=${encodeURIComponent(
          token,
        )}`;

        const resp = await fetch(url);
        const data = await resp.json();
        if (!resp.ok || data.error) continue;

        const nombre = toTitleCaseEs((data.first_name || '').trim()) || '';
        const apellido = toTitleCaseEs((data.last_name || '').trim()) || '';
        const pic = data?.picture?.data?.url || null;

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
