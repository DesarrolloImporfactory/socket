/**
 * metaAds.controller.js
 * Controller para integración Meta Marketing API (ads_read + ads_management)
 */

const axios = require('axios');
const { db } = require('../database/config');
const logger = require('../utils/logger');

const FB_APP_ID = process.env.FB_APP_ID;
const FB_APP_SECRET = process.env.FB_APP_SECRET;
const GRAPH_BASE = `https://graph.facebook.com/${process.env.GRAPH_VERSION}`;

// ══════════════════════════════════════════════
// HELPERS
// ══════════════════════════════════════════════

async function getAdConnection(id_configuracion) {
  const rows = await db.query(
    `SELECT * FROM meta_ad_connections WHERE id_configuracion = ? AND status = 'active' LIMIT 1`,
    { replacements: [id_configuracion], type: db.QueryTypes.SELECT },
  );
  return rows[0] || null;
}

/**
 * parseActions — usa SOLO el action_type estándar (sin offsite_conversion.* duplicados)
 * Meta devuelve ambos: "purchase" y "offsite_conversion.fb_pixel_purchase" con el mismo valor.
 * Sumar ambos duplica los números.
 */
function parseActions(actions) {
  const result = {
    purchases: 0,
    complete_registrations: 0,
    messaging_conversations: 0,
    leads: 0,
    add_to_cart: 0,
  };
  if (!Array.isArray(actions)) return result;
  for (const a of actions) {
    const t = a.action_type;
    const v = Number(a.value) || 0;
    if (t === 'purchase') result.purchases += v;
    if (t === 'complete_registration') result.complete_registrations += v;
    if (t === 'onsite_conversion.messaging_conversation_started_7d')
      result.messaging_conversations += v;
    if (t === 'lead') result.leads += v;
    if (t === 'add_to_cart') result.add_to_cart += v;
  }
  return result;
}

/**
 * parseActionValues — solo "purchase" estándar, no el offsite_conversion variant
 */
function parseActionValues(actionValues) {
  if (!Array.isArray(actionValues)) return 0;
  let total = 0;
  for (const a of actionValues) {
    if (a.action_type === 'purchase') {
      total += Number(a.value) || 0;
    }
  }
  return total;
}

/**
 * Extrae CPA de un action_type específico desde cost_per_action_type.
 */
function extractCpa(costPerActionType, actionTypes) {
  if (!Array.isArray(costPerActionType)) return 0;
  const found = costPerActionType.find((c) =>
    actionTypes.includes(c.action_type),
  );
  return Number(found?.value) || 0;
}

function metaAx(token) {
  return axios.create({
    headers: { Authorization: `Bearer ${token}` },
    timeout: 20000,
    validateStatus: () => true,
  });
}

function assertMeta(resp, label) {
  if (resp.status >= 200 && resp.status < 300) return resp.data;
  const err = new Error(
    `Meta ${label}: ${resp.status} - ${JSON.stringify(resp.data?.error || resp.data)}`,
  );
  err.meta_status = resp.status;
  err.meta_error = resp.data?.error || resp.data;
  throw err;
}

function buildDateParams(query) {
  if (query.time_range) {
    try {
      const tr =
        typeof query.time_range === 'string'
          ? JSON.parse(query.time_range)
          : query.time_range;
      return { time_range: JSON.stringify(tr) };
    } catch {}
  }
  return { date_preset: query.date_preset || 'last_30d' };
}

// ══════════════════════════════════════════════
// 1) CONECTAR AD ACCOUNT
// ══════════════════════════════════════════════

exports.conectarAdAccount = async (req, res) => {
  try {
    const {
      code,
      id_configuracion,
      id_usuario,
      redirect_uri,
      ad_account_id,
      access_token: providedToken,
    } = req.body;

    // PASO 2: Confirmar selección
    if (ad_account_id && providedToken && id_configuracion) {
      const ax = metaAx(providedToken);
      const verifyResp = await ax.get(`${GRAPH_BASE}/${ad_account_id}`, {
        params: { fields: 'id,name,account_status,currency,timezone_name' },
      });
      const acct = assertMeta(verifyResp, 'verify_account');

      const existing = await db.query(
        `SELECT id FROM meta_ad_connections WHERE id_configuracion = ? AND ad_account_id = ?`,
        {
          replacements: [id_configuracion, ad_account_id],
          type: db.QueryTypes.SELECT,
        },
      );

      if (existing.length) {
        await db.query(
          `UPDATE meta_ad_connections SET
             access_token = ?, ad_account_name = ?, currency = ?,
             timezone_name = ?, account_status = ?, status = 'active', updated_at = NOW()
           WHERE id_configuracion = ? AND ad_account_id = ?`,
          {
            replacements: [
              providedToken,
              acct.name,
              acct.currency,
              acct.timezone_name,
              acct.account_status,
              id_configuracion,
              ad_account_id,
            ],
          },
        );
      } else {
        await db.query(
          `INSERT INTO meta_ad_connections
             (id_configuracion, id_usuario, ad_account_id, ad_account_name, access_token, currency, timezone_name, account_status)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          {
            replacements: [
              id_configuracion,
              id_usuario,
              ad_account_id,
              acct.name,
              providedToken,
              acct.currency,
              acct.timezone_name,
              acct.account_status,
            ],
          },
        );
      }

      return res.json({
        success: true,
        message: 'Cuenta publicitaria conectada correctamente.',
        ad_account_id,
        ad_account_name: acct.name,
      });
    }

    // PASO 1: Exchange code → listar cuentas
    if (!code || !id_configuracion || !id_usuario) {
      return res.status(400).json({
        success: false,
        message: 'Faltan campos: code, id_configuracion, id_usuario',
      });
    }

    let userToken;
    try {
      const tokenResp = await axios.get(`${GRAPH_BASE}/oauth/access_token`, {
        params: { client_id: FB_APP_ID, client_secret: FB_APP_SECRET, code },
      });
      userToken = tokenResp.data?.access_token;
    } catch (e1) {
      try {
        const tokenResp2 = await axios.get(`${GRAPH_BASE}/oauth/access_token`, {
          params: {
            client_id: FB_APP_ID,
            client_secret: FB_APP_SECRET,
            code,
            redirect_uri:
              redirect_uri || 'https://chatcenter.imporfactory.app/conexiones',
          },
        });
        userToken = tokenResp2.data?.access_token;
      } catch (e2) {
        return res.status(400).json({
          success: false,
          message: 'No se pudo intercambiar el código por token.',
          error_sin: e1?.response?.data || e1.message,
          error_con: e2?.response?.data || e2.message,
        });
      }
    }
    if (!userToken) throw new Error('No se obtuvo access_token de Meta');

    const ax = metaAx(userToken);
    const adResp = await ax.get(`${GRAPH_BASE}/me/adaccounts`, {
      params: {
        fields: 'id,name,account_status,currency,timezone_name',
        limit: 50,
      },
    });
    const adData = assertMeta(adResp, 'adaccounts');
    const accounts = adData.data || [];

    if (!accounts.length) {
      return res.json({
        success: false,
        message: 'No se encontraron cuentas publicitarias.',
      });
    }

    return res.json({
      success: true,
      step: 'select_account',
      accounts: accounts.map((a) => ({
        ad_account_id: a.id,
        name: a.name,
        account_status: a.account_status,
        currency: a.currency,
        timezone_name: a.timezone_name,
      })),
      _token: userToken,
    });
  } catch (err) {
    logger.error('metaAds.conectar error:', err.message);
    return res.status(400).json({
      success: false,
      message: err.meta_error?.message || err.message,
    });
  }
};

// ══════════════════════════════════════════════
// 2) DESCONECTAR
// ══════════════════════════════════════════════

exports.desconectarAdAccount = async (req, res) => {
  try {
    const { id_configuracion } = req.body;
    if (!id_configuracion)
      return res
        .status(400)
        .json({ success: false, message: 'Falta id_configuracion' });

    await db.query(
      `UPDATE meta_ad_connections SET status = 'disconnected', updated_at = NOW() WHERE id_configuracion = ? AND status = 'active'`,
      { replacements: [id_configuracion] },
    );
    return res.json({
      success: true,
      message: 'Cuenta publicitaria desconectada.',
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

// ══════════════════════════════════════════════
// 3) OBTENER CONEXIÓN ACTIVA
// ══════════════════════════════════════════════

exports.obtenerConexion = async (req, res) => {
  try {
    const { id_configuracion } = req.query;
    if (!id_configuracion)
      return res
        .status(400)
        .json({ success: false, message: 'Falta id_configuracion' });

    const conn = await getAdConnection(id_configuracion);
    return res.json({
      success: true,
      connected: !!conn,
      data: conn
        ? {
            ad_account_id: conn.ad_account_id,
            ad_account_name: conn.ad_account_name,
            currency: conn.currency,
            timezone_name: conn.timezone_name,
            status: conn.status,
          }
        : null,
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

// ══════════════════════════════════════════════
// 4) INSIGHTS - ACCOUNT LEVEL
// ══════════════════════════════════════════════

exports.insightsAccount = async (req, res) => {
  try {
    const { id_configuracion } = req.query;
    const dateParams = buildDateParams(req.query);

    const conn = await getAdConnection(id_configuracion);
    if (!conn)
      return res.json({
        success: false,
        message: 'No hay cuenta de ads conectada.',
      });

    const ax = metaAx(conn.access_token);

    const resp = await ax.get(`${GRAPH_BASE}/${conn.ad_account_id}/insights`, {
      params: {
        fields: [
          'spend',
          'impressions',
          'clicks',
          'ctr',
          'cpc',
          'cpm',
          'actions',
          'action_values',
          'cost_per_action_type',
        ].join(','),
        ...dateParams,
        level: 'account',
      },
    });

    const data = assertMeta(resp, 'insights_account');
    const row = data.data?.[0] || {};

    const actions = parseActions(row.actions);
    const purchaseValue = parseActionValues(row.action_values);
    const spend = Number(row.spend) || 0;

    // CPA Purchase
    let cpaPurchase = extractCpa(row.cost_per_action_type, ['purchase']);
    if (!cpaPurchase && actions.purchases > 0)
      cpaPurchase = spend / actions.purchases;

    // CPA Messaging
    let cpaMessaging = extractCpa(row.cost_per_action_type, [
      'onsite_conversion.messaging_conversation_started_7d',
    ]);
    if (!cpaMessaging && actions.messaging_conversations > 0)
      cpaMessaging = spend / actions.messaging_conversations;

    // CPA Lead
    let cpaLead = extractCpa(row.cost_per_action_type, ['lead']);
    if (!cpaLead && actions.leads > 0) cpaLead = spend / actions.leads;

    // CPA Registration
    let cpaRegistration = extractCpa(row.cost_per_action_type, [
      'complete_registration',
    ]);
    if (!cpaRegistration && actions.complete_registrations > 0)
      cpaRegistration = spend / actions.complete_registrations;

    return res.json({
      success: true,
      currency: conn.currency,
      data: {
        spend,
        impressions: Number(row.impressions) || 0,
        clicks: Number(row.clicks) || 0,
        ctr: Number(row.ctr) || 0,
        cpc: Number(row.cpc) || 0,
        cpm: Number(row.cpm) || 0,
        purchases: actions.purchases,
        purchase_value: purchaseValue,
        roas: spend > 0 ? +(purchaseValue / spend).toFixed(2) : 0,
        cpa_purchase: +cpaPurchase.toFixed(2),
        complete_registrations: actions.complete_registrations,
        cpa_registration: +cpaRegistration.toFixed(2),
        messaging_conversations: actions.messaging_conversations,
        cpa_messaging: +cpaMessaging.toFixed(2),
        leads: actions.leads,
        cpa_lead: +cpaLead.toFixed(2),
        add_to_cart: actions.add_to_cart,
        actions_raw: row.actions || [],
        action_values_raw: row.action_values || [],
      },
    });
  } catch (err) {
    logger.error('insightsAccount:', err.message);
    return res.status(err.meta_status || 500).json({
      success: false,
      message: err.meta_error?.message || err.message,
    });
  }
};

// ══════════════════════════════════════════════
// 5) INSIGHTS - CAMPAIGN LEVEL
// ══════════════════════════════════════════════

exports.insightsCampaigns = async (req, res) => {
  try {
    const { id_configuracion } = req.query;
    const dateParams = buildDateParams(req.query);

    const conn = await getAdConnection(id_configuracion);
    if (!conn)
      return res.json({
        success: false,
        message: 'No hay cuenta de ads conectada.',
      });

    const ax = metaAx(conn.access_token);

    const resp = await ax.get(`${GRAPH_BASE}/${conn.ad_account_id}/insights`, {
      params: {
        fields: [
          'campaign_id',
          'campaign_name',
          'spend',
          'impressions',
          'clicks',
          'ctr',
          'cpc',
          'actions',
          'action_values',
          'cost_per_action_type',
        ].join(','),
        ...dateParams,
        level: 'campaign',
        limit: 100,
      },
    });

    const data = assertMeta(resp, 'insights_campaigns');

    const statusResp = await ax.get(
      `${GRAPH_BASE}/${conn.ad_account_id}/campaigns`,
      {
        params: {
          fields:
            'id,name,status,effective_status,daily_budget,lifetime_budget',
          limit: 100,
        },
      },
    );
    const statusData = assertMeta(statusResp, 'campaigns_status');
    const statusMap = {};
    for (const c of statusData.data || []) statusMap[c.id] = c;

    const campaigns = (data.data || []).map((row) => {
      const actions = parseActions(row.actions);
      const purchaseValue = parseActionValues(row.action_values);
      const spend = Number(row.spend) || 0;
      const status = statusMap[row.campaign_id] || {};

      let cpaMessaging = extractCpa(row.cost_per_action_type, [
        'onsite_conversion.messaging_conversation_started_7d',
      ]);
      if (!cpaMessaging && actions.messaging_conversations > 0)
        cpaMessaging = spend / actions.messaging_conversations;

      let cpaLead = extractCpa(row.cost_per_action_type, ['lead']);
      if (!cpaLead && actions.leads > 0) cpaLead = spend / actions.leads;

      return {
        campaign_id: row.campaign_id,
        campaign_name: row.campaign_name,
        spend,
        impressions: Number(row.impressions) || 0,
        clicks: Number(row.clicks) || 0,
        ctr: Number(row.ctr) || 0,
        cpc: Number(row.cpc) || 0,
        purchases: actions.purchases,
        purchase_value: purchaseValue,
        roas: spend > 0 ? +(purchaseValue / spend).toFixed(2) : 0,
        cpa_purchase:
          actions.purchases > 0 ? +(spend / actions.purchases).toFixed(2) : 0,
        complete_registrations: actions.complete_registrations,
        messaging_conversations: actions.messaging_conversations,
        cpa_messaging: +cpaMessaging.toFixed(2),
        leads: actions.leads,
        cpa_lead: +cpaLead.toFixed(2),
        add_to_cart: actions.add_to_cart,
        status: status.status || null,
        effective_status: status.effective_status || null,
        daily_budget: status.daily_budget
          ? Number(status.daily_budget) / 100
          : null,
        lifetime_budget: status.lifetime_budget
          ? Number(status.lifetime_budget) / 100
          : null,
      };
    });

    campaigns.sort((a, b) => b.spend - a.spend);

    return res.json({
      success: true,
      currency: conn.currency,
      data: campaigns,
    });
  } catch (err) {
    logger.error('insightsCampaigns:', err.message);
    return res.status(err.meta_status || 500).json({
      success: false,
      message: err.meta_error?.message || err.message,
    });
  }
};

// ══════════════════════════════════════════════
// 6) TOP ADS
// ══════════════════════════════════════════════

exports.insightsTopAds = async (req, res) => {
  try {
    const { id_configuracion, limit: rawLimit } = req.query;
    const dateParams = buildDateParams(req.query);
    const limit = Math.min(Number(rawLimit) || 10, 50);

    const conn = await getAdConnection(id_configuracion);
    if (!conn)
      return res.json({
        success: false,
        message: 'No hay cuenta de ads conectada.',
      });

    const ax = metaAx(conn.access_token);

    const resp = await ax.get(`${GRAPH_BASE}/${conn.ad_account_id}/insights`, {
      params: {
        fields: [
          'ad_id',
          'ad_name',
          'campaign_name',
          'spend',
          'impressions',
          'clicks',
          'ctr',
          'cpc',
          'actions',
          'action_values',
          'cost_per_action_type',
        ].join(','),
        ...dateParams,
        level: 'ad',
        sort: ['spend_descending'],
        limit,
      },
    });

    const data = assertMeta(resp, 'insights_top_ads');

    const adIds = [
      ...new Set((data.data || []).map((r) => r.ad_id).filter(Boolean)),
    ];
    const creativeMap = {};
    if (adIds.length) {
      await Promise.all(
        adIds.map(async (adId) => {
          try {
            const crResp = await ax.get(`${GRAPH_BASE}/${adId}`, {
              params: {
                fields: 'creative{effective_object_story_id,thumbnail_url}',
              },
            });
            if (crResp.status >= 200 && crResp.status < 300) {
              creativeMap[adId] = crResp.data?.creative || {};
            }
          } catch {}
        }),
      );
    }

    const ads = (data.data || []).map((row) => {
      const actions = parseActions(row.actions);
      const purchaseValue = parseActionValues(row.action_values);
      const spend = Number(row.spend) || 0;
      const creative = creativeMap[row.ad_id] || {};

      let cpaMessaging = extractCpa(row.cost_per_action_type, [
        'onsite_conversion.messaging_conversation_started_7d',
      ]);
      if (!cpaMessaging && actions.messaging_conversations > 0)
        cpaMessaging = spend / actions.messaging_conversations;

      let cpaLead = extractCpa(row.cost_per_action_type, ['lead']);
      if (!cpaLead && actions.leads > 0) cpaLead = spend / actions.leads;

      return {
        ad_id: row.ad_id,
        ad_name: row.ad_name,
        campaign_name: row.campaign_name || null,
        post_id: creative.effective_object_story_id || null,
        thumbnail_url: creative.thumbnail_url || null,
        spend,
        impressions: Number(row.impressions) || 0,
        clicks: Number(row.clicks) || 0,
        ctr: Number(row.ctr) || 0,
        cpc: Number(row.cpc) || 0,
        purchases: actions.purchases,
        purchase_value: purchaseValue,
        roas: spend > 0 ? +(purchaseValue / spend).toFixed(2) : 0,
        cpa_purchase:
          actions.purchases > 0 ? +(spend / actions.purchases).toFixed(2) : 0,
        complete_registrations: actions.complete_registrations,
        messaging_conversations: actions.messaging_conversations,
        cpa_messaging: +cpaMessaging.toFixed(2),
        leads: actions.leads,
        cpa_lead: +cpaLead.toFixed(2),
        add_to_cart: actions.add_to_cart,
      };
    });

    return res.json({ success: true, currency: conn.currency, data: ads });
  } catch (err) {
    logger.error('insightsTopAds:', err.message);
    return res.status(err.meta_status || 500).json({
      success: false,
      message: err.meta_error?.message || err.message,
    });
  }
};

// ══════════════════════════════════════════════
// 7) LISTAR CAMPAÑAS
// ══════════════════════════════════════════════

exports.listarCampanias = async (req, res) => {
  try {
    const { id_configuracion } = req.query;
    const conn = await getAdConnection(id_configuracion);
    if (!conn)
      return res.json({
        success: false,
        message: 'No hay cuenta de ads conectada.',
      });

    const ax = metaAx(conn.access_token);
    const resp = await ax.get(`${GRAPH_BASE}/${conn.ad_account_id}/campaigns`, {
      params: {
        fields:
          'id,name,status,effective_status,daily_budget,lifetime_budget,objective,start_time,stop_time',
        limit: 100,
      },
    });
    const data = assertMeta(resp, 'campaigns');

    const campaigns = (data.data || []).map((c) => ({
      id: c.id,
      name: c.name,
      status: c.status,
      effective_status: c.effective_status,
      objective: c.objective,
      daily_budget: c.daily_budget ? Number(c.daily_budget) / 100 : null,
      lifetime_budget: c.lifetime_budget
        ? Number(c.lifetime_budget) / 100
        : null,
      start_time: c.start_time || null,
      stop_time: c.stop_time || null,
    }));

    return res.json({ success: true, data: campaigns });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

// ══════════════════════════════════════════════
// 8) TOGGLE CAMPAÑA
// ══════════════════════════════════════════════

exports.toggleCampania = async (req, res) => {
  try {
    const { id_configuracion, campaign_id, status } = req.body;
    if (!campaign_id || !['PAUSED', 'ACTIVE'].includes(status)) {
      return res.status(400).json({
        success: false,
        message: 'campaign_id y status (PAUSED|ACTIVE) requeridos.',
      });
    }

    const conn = await getAdConnection(id_configuracion);
    if (!conn)
      return res.json({
        success: false,
        message: 'No hay cuenta de ads conectada.',
      });

    const ax = metaAx(conn.access_token);
    const resp = await ax.post(`${GRAPH_BASE}/${campaign_id}`, { status });

    if (resp.status < 200 || resp.status >= 300) {
      return res.json({
        success: false,
        message: 'Meta rechazó el cambio. ¿Tienes permiso ads_management?',
        meta_error: resp.data?.error || resp.data,
      });
    }

    return res.json({ success: true, campaign_id, new_status: status });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

// ══════════════════════════════════════════════
// 9) SYNC MANUAL
// ══════════════════════════════════════════════

exports.syncInsights = async (req, res) => {
  try {
    const { id_configuracion, date_preset } = req.body;
    const preset = date_preset || 'last_30d';

    const conn = await getAdConnection(id_configuracion);
    if (!conn)
      return res.json({
        success: false,
        message: 'No hay cuenta de ads conectada.',
      });

    const ax = metaAx(conn.access_token);
    const acctResp = await ax.get(
      `${GRAPH_BASE}/${conn.ad_account_id}/insights`,
      {
        params: {
          fields: 'spend,impressions,clicks,ctr,cpc,cpm,actions,action_values',
          date_preset: preset,
          level: 'account',
        },
      },
    );

    const acctData = assertMeta(acctResp, 'sync_account');
    const row = acctData.data?.[0];

    if (row) {
      const actions = parseActions(row.actions);
      const purchaseValue = parseActionValues(row.action_values);
      const spend = Number(row.spend) || 0;

      await db.query(
        `INSERT INTO meta_ads_insights_cache
           (id_connection, ad_account_id, level, date_start, date_stop, date_preset,
            spend, impressions, clicks, ctr, cpc, cpm, actions_json, action_values_json,
            purchases, purchase_value, complete_registrations, messaging_conversations, leads, add_to_cart,
            roas, cpa_purchase)
         VALUES (?, ?, 'account', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           spend=VALUES(spend), impressions=VALUES(impressions), clicks=VALUES(clicks),
           ctr=VALUES(ctr), cpc=VALUES(cpc), cpm=VALUES(cpm),
           actions_json=VALUES(actions_json), action_values_json=VALUES(action_values_json),
           purchases=VALUES(purchases), purchase_value=VALUES(purchase_value),
           complete_registrations=VALUES(complete_registrations), messaging_conversations=VALUES(messaging_conversations),
           leads=VALUES(leads), add_to_cart=VALUES(add_to_cart),
           roas=VALUES(roas), cpa_purchase=VALUES(cpa_purchase), fetched_at=NOW()`,
        {
          replacements: [
            conn.id,
            conn.ad_account_id,
            row.date_start,
            row.date_stop,
            preset,
            spend,
            row.impressions || 0,
            row.clicks || 0,
            row.ctr || 0,
            row.cpc || 0,
            row.cpm || 0,
            JSON.stringify(row.actions || []),
            JSON.stringify(row.action_values || []),
            actions.purchases,
            purchaseValue,
            actions.complete_registrations,
            actions.messaging_conversations,
            actions.leads,
            actions.add_to_cart,
            spend > 0 ? +(purchaseValue / spend).toFixed(4) : 0,
            actions.purchases > 0 ? +(spend / actions.purchases).toFixed(2) : 0,
          ],
        },
      );
    }

    return res.json({
      success: true,
      message: 'Insights sincronizados correctamente.',
      date_preset: preset,
    });
  } catch (err) {
    logger.error('syncInsights:', err.message);
    return res.status(500).json({ success: false, message: err.message });
  }
};
