const axios = require('axios');
const crypto = require('crypto');
const { db } = require('../database/config');

const GRAPH_VERSION = 'v22.0';
const APP_SECRET = process.env.FB_APP_SECRET;

// Campos “ricos” (solo si hay permiso). Incluye picture con tipo large.
const PAGE_FIELDS = [
  'name',
  'username',
  'about',
  'category',
  'fan_count',
  'link',
  'picture.type(large){url,is_silhouette}',
].join(',');

// refresco cada 24h
const REFRESH_MS = 24 * 60 * 60 * 1000;

/** Genera el appsecret_proof para un access_token dado */
function buildAppSecretProof(accessToken) {
  return crypto
    .createHmac('sha256', APP_SECRET)
    .update(accessToken)
    .digest('hex');
}

/** Cliente Axios centralizado para Graph con inyección automática de appsecret_proof */
const graph = axios.create({
  baseURL: `https://graph.facebook.com/${GRAPH_VERSION}/`,
  timeout: 15000,
});

graph.interceptors.request.use((config) => {
  const token = config?.params?.access_token;
  if (token && APP_SECRET) {
    const proof = buildAppSecretProof(token);
    config.params = { ...(config.params || {}), appsecret_proof: proof };
  }
  return config;
});

/** Obtiene información rica de la Page (requiere permisos/tareas correctas) */
async function fetchPageInfoFromGraph(pageId, pageAccessToken) {
  const { data } = await graph.get(`${pageId}`, {
    params: { fields: PAGE_FIELDS, access_token: pageAccessToken },
  });
  return {
    name: data?.name ?? null,
    username: data?.username ?? null,
    about: data?.about ?? null,
    category: data?.category ?? null,
    fan_count: data?.fan_count ?? null,
    link: data?.link ?? null,
    picture_url: data?.picture?.data?.url ?? null,
  };
}

/** Fallback: solo foto vía edge /picture (devuelve JSON si redirect=0) */
async function fetchPagePictureOnly(pageId, pageAccessToken) {
  const { data } = await graph.get(`${pageId}/picture`, {
    params: { redirect: 0, type: 'large', access_token: pageAccessToken },
  });
  return data?.data?.url ?? null;
}

/** Fallback opcional extra: foto vía field picture */
async function fetchPagePictureViaFields(pageId, pageAccessToken) {
  const { data } = await graph.get(`${pageId}`, {
    params: {
      fields: 'picture.type(large){url,is_silhouette}',
      access_token: pageAccessToken,
    },
  });
  return data?.picture?.data?.url ?? null;
}

exports.listConnections = async (req, res) => {
  try {
    const id_configuracion = Number(
      req.query.id_configuracion || req.body?.id_configuracion || 0
    );
    const force = String(req.query.force || '') === '1';
    if (!id_configuracion) {
      return res
        .status(400)
        .json({ success: false, message: 'Falta id_configuracion' });
    }

    // 1) Traer pages (incluye PAT)
    const pages = await db.query(
      `SELECT 
         id_messenger_page,
         id_configuracion,
         page_id,
         page_name,
         page_access_token,
         profile_picture_url,
         page_username,
         about,
         category,
         fan_count,
         page_link,
         subscribed,
         status,
         connected_at,
         updated_at,
         profile_refreshed_at
       FROM messenger_pages
       WHERE id_configuracion = ?
       ORDER BY connected_at DESC`,
      {
        replacements: [id_configuracion],
        type: db.QueryTypes.SELECT,
      }
    );

    // 2) ¿A quién refrescamos?
    const now = Date.now();
    const toRefresh = pages.filter((p) => {
      const last = p.profile_refreshed_at
        ? new Date(p.profile_refreshed_at).getTime()
        : 0;
      const stale = now - last > REFRESH_MS;
      const missingAnything =
        !p.profile_picture_url ||
        !p.page_username ||
        p.fan_count == null ||
        !p.category ||
        !p.page_link ||
        !p.about;
      return (force || stale || missingAnything) && !!p.page_access_token;
    });

    // 3) Intentar refresco “rico”; si falla, caer a foto-only (y opcionalmente a fields)
    for (const p of toRefresh) {
      try {
        const info = await fetchPageInfoFromGraph(
          p.page_id,
          p.page_access_token
        );

        await db.query(
          `UPDATE messenger_pages
             SET page_name            = COALESCE(?, page_name),
                 profile_picture_url  = COALESCE(?, profile_picture_url),
                 page_username        = COALESCE(?, page_username),
                 about                = COALESCE(?, about),
                 category             = COALESCE(?, category),
                 fan_count            = COALESCE(?, fan_count),
                 page_link            = COALESCE(?, page_link),
                 profile_refreshed_at = NOW(),
                 updated_at           = NOW()
           WHERE id_messenger_page = ?`,
          {
            replacements: [
              info.name,
              info.picture_url,
              info.username,
              info.about,
              info.category,
              info.fan_count,
              info.link,
              p.id_messenger_page,
            ],
          }
        );
      } catch (e) {
        const err = e?.response?.data?.error;
        console.warn('[MS][connections][rich-refresh][WARN]', p.page_id, {
          code: err?.code,
          subcode: err?.error_subcode,
          type: err?.type,
          msg: err?.message || e.message,
        });

        try {
          let pictureUrl = await fetchPagePictureOnly(
            p.page_id,
            p.page_access_token
          );

          // Fallback extra opcional si /picture no trajo nada
          if (!pictureUrl) {
            // pictureUrl = await fetchPagePictureViaFields(p.page_id, p.page_access_token);
          }

          if (pictureUrl) {
            await db.query(
              `UPDATE messenger_pages
                 SET profile_picture_url  = ?,
                     profile_refreshed_at = NOW(),
                     updated_at           = NOW()
               WHERE id_messenger_page = ?`,
              { replacements: [pictureUrl, p.id_messenger_page] }
            );
          } else {
            // al menos marcar refresco para no martillar
            await db.query(
              `UPDATE messenger_pages
                 SET profile_refreshed_at = NOW(),
                     updated_at           = NOW()
               WHERE id_messenger_page = ?`,
              { replacements: [p.id_messenger_page] }
            );
          }
        } catch (e2) {
          const err2 = e2?.response?.data?.error;
          console.warn('[MS][connections][picture-refresh][WARN]', p.page_id, {
            code: err2?.code,
            subcode: err2?.error_subcode,
            type: err2?.type,
            msg: err2?.message || e2.message,
          });
        }
      }
    }

    // 4) Respuesta final (sin tokens)
    const finalRows = await db.query(
      `SELECT 
         page_id,
         page_name,
         profile_picture_url,
         page_username,
         about,
         category,
         fan_count,
         page_link,
         subscribed,
         status,
         connected_at,
         profile_refreshed_at
       FROM messenger_pages
       WHERE id_configuracion = ?
       ORDER BY connected_at DESC`,
      {
        replacements: [id_configuracion],
        type: db.QueryTypes.SELECT,
      }
    );

    return res.json({ success: true, data: finalRows || [] });
  } catch (err) {
    console.error(
      '[MS][listConnections] Error:',
      err?.response?.data || err.message
    );
    return res.status(500).json({
      success: false,
      message: 'Error al obtener conexiones de Messenger',
    });
  }
};
