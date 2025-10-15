const AppError = require('../utils/appError');
const catchAsync = require('../utils/catchAsync');
const InstagramService = require('../services/instagram.service');
const { db } = require('../database/config');
const axios = require('axios');

exports.verifyWebhook = (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === process.env.FB_VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.status(403).send('Forbidden');
};

exports.receiveWebhook = catchAsync(async (req, res, next) => {
  const body = req.body;
  if (!body || typeof body !== 'object') return res.sendStatus(200);

  if (body.object !== 'page' && body.object !== 'instagram') {
    return res.sendStatus(200);
  }

  // Procesa entradas
  for (const entry of body.entry || []) {
    const events = entry.messaging || [];
    for (const event of events) {
      try {
        await InstagramService.routeEvent(event);
      } catch (e) {
        console.warn('[IG CONTROLLER][routeEvent][WARN]', e.message);
      }
    }
  }

  return res.sendStatus(200);
});

exports.listConnections = async (req, res) => {
  try {
    const id_configuracion = Number(
      req.query.id_configuracion || req.body?.id_configuracion || 0
    );
    if (!id_configuracion) {
      return res
        .status(400)
        .json({ success: false, message: 'Falta id_configuracion' });
    }

    const [rows] = await db.query(
      `SELECT page_id, page_name, ig_id, ig_username, status, connected_at, page_access_token
       FROM instagram_pages
       WHERE id_configuracion = ?
       ORDER BY connected_at DESC`,
      { replacements: [id_configuracion] }
    );

    // enrich IG profile data en paralelo
    const enriched = await Promise.all(
      (rows || []).map(async (r) => {
        try {
          if (!r.ig_id || !r.page_access_token) return r;
          const { data: ig } = await axios.get(
            `https://graph.facebook.com/v19.0/${r.ig_id}`,
            {
              params: {
                fields:
                  'biography,profile_picture_url,followers_count,follows_count,media_count,name,username',
                access_token: r.page_access_token,
              },
              timeout: 12000,
            }
          );

          return {
            ...r,
            profile_picture_url: ig.profile_picture_url || null,
            ig_full_name: ig.name || null,
            biography: ig.biography || null,
            followers_count: ig.followers_count ?? null,
            follows_count: ig.follows_count ?? null,
            media_count: ig.media_count ?? null,
            ig_username: ig.username || r.ig_username, // refresca si cambió
          };
        } catch {
          return r; // sin bloquear si falla IG
        }
      })
    );

    //no expongas el token
    const safe = enriched.map(({ page_access_token, ...rest }) => rest);

    return res.json({ success: true, data: safe });
  } catch (err) {
    console.error('[IG][listConnections] Error:', err.message);
    return res.status(500).json({
      success: false,
      message: 'Error al obtener conexiones de Instagram',
    });
  }
};
