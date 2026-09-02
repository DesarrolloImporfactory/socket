/**
 * metaAdsLauncher.service.js
 * Escritura contra la Meta Marketing API: crea el paquete completo de una
 * campaña CTWA (click-to-WhatsApp) — campaña + conjunto + creativo + anuncio —
 * en la cuenta publicitaria conectada (meta_ad_connections.access_token).
 *
 * Todo el embudo del sistema es CTWA: el ad_id que sale de aquí es exactamente
 * el referral.source_id que después llega por el webhook de WhatsApp, así que
 * el controller pre-registra el vínculo en anuncios_producto al lanzar.
 */

const axios = require('axios');
const logger = require('../utils/logger');

const FB_APP_ID = process.env.FB_APP_ID;
const FB_APP_SECRET = process.env.FB_APP_SECRET;
const GRAPH_BASE = `https://graph.facebook.com/${process.env.GRAPH_VERSION}`;

const ACT = (id) => (String(id).startsWith('act_') ? String(id) : `act_${id}`);

function metaAx(token) {
  return axios.create({
    headers: { Authorization: `Bearer ${token}` },
    timeout: 30000,
    validateStatus: () => true,
  });
}

function assertMeta(resp, label) {
  if (resp.status >= 200 && resp.status < 300) return resp.data;
  const err = new Error(
    `Meta ${label}: ${resp.status} - ${JSON.stringify(
      resp.data?.error || resp.data,
    )}`,
  );
  err.meta_status = resp.status;
  err.meta_error = resp.data?.error || resp.data;
  err.paso = label;
  throw err;
}

/* ── Imagen del anuncio ──
   Meta exige que la imagen viva en la cuenta publicitaria (act_X/adimages);
   el creativo la referencia por hash, no por URL. Se sube en base64. */
async function subirImagen({ conn, buffer, filename }) {
  const ax = metaAx(conn.access_token);
  const resp = await ax.post(`${GRAPH_BASE}/${ACT(conn.ad_account_id)}/adimages`, {
    bytes: buffer.toString('base64'),
  });
  const data = assertMeta(resp, 'adimages');
  // La respuesta viene como { images: { <clave>: { hash, url } } } y la clave
  // no es predecible cuando se sube por bytes: se toma la primera.
  const primera = Object.values(data?.images || {})[0];
  if (!primera?.hash) {
    const err = new Error('Meta no devolvió el hash de la imagen.');
    err.meta_error = data;
    throw err;
  }
  return { hash: primera.hash, url: primera.url || null, filename };
}

/* ── Video del anuncio ──
   Los videos van a act_X/advideos (host graph-video) y el creativo los
   referencia por video_id + una miniatura obligatoria. Meta procesa el video
   de forma asíncrona: la miniatura se obtiene con un pequeño polling. */
async function subirVideo({ conn, buffer, filename, mimetype }) {
  const act = ACT(conn.ad_account_id);
  const fd = new FormData();
  fd.append(
    'source',
    new Blob([buffer], { type: mimetype || 'video/mp4' }),
    filename || 'video.mp4',
  );
  const resp = await axios.post(
    `https://graph-video.facebook.com/${process.env.GRAPH_VERSION}/${act}/advideos`,
    fd,
    {
      headers: { Authorization: `Bearer ${conn.access_token}` },
      timeout: 180000,
      maxBodyLength: Infinity,
      validateStatus: () => true,
    },
  );
  const data = assertMeta(resp, 'advideos');
  if (!data?.id) {
    const err = new Error('Meta no devolvió el id del video.');
    err.meta_error = data;
    throw err;
  }
  return { video_id: String(data.id) };
}

async function obtenerMiniaturaVideo(conn, video_id, intentos = 5) {
  const ax = metaAx(conn.access_token);
  for (let i = 0; i < intentos; i++) {
    const r = await ax.get(`${GRAPH_BASE}/${video_id}/thumbnails`, {
      params: { fields: 'uri,is_preferred' },
    });
    if (r.status >= 200 && r.status < 300) {
      const lista = r.data?.data || [];
      const pref = lista.find((t) => t.is_preferred) || lista[0];
      if (pref?.uri) return pref.uri;
    }
    await new Promise((res) => setTimeout(res, 3000));
  }
  return null;
}

function construirTargeting(cfg) {
  // Dos modos de alcance: países completos, o provincias/ciudades puntuales
  // (regions/cities de Meta, elegidas con la búsqueda adgeolocation).
  const geo = cfg.geo || { modo: 'paises', paises: cfg.paises };
  let geo_locations;
  if (geo.modo === 'especifico') {
    geo_locations = {};
    const regions = (geo.lugares || [])
      .filter((l) => l.type === 'region')
      .map((l) => ({ key: String(l.key) }));
    const cities = (geo.lugares || [])
      .filter((l) => l.type === 'city')
      .map((l) => ({ key: String(l.key) }));
    if (regions.length) geo_locations.regions = regions;
    if (cities.length) geo_locations.cities = cities;
  } else {
    geo_locations = { countries: geo.paises };
  }

  const targeting = {
    geo_locations,
    age_min: cfg.edad_min,
    age_max: cfg.edad_max,
    // Sin esta bandera explícita las versiones nuevas de la API rechazan el
    // conjunto ("advantage audience flag required"); 0 = respetar el alcance
    // que definió el cliente en lugar de expandirlo automáticamente.
    targeting_automation: { advantage_audience: 0 },
  };
  if (cfg.genero === 'male') targeting.genders = [1];
  if (cfg.genero === 'female') targeting.genders = [2];
  return targeting;
}

/* Búsqueda de zonas de segmentación (provincias y ciudades) con la misma
   búsqueda que usa el Administrador de anuncios. */
async function buscarGeo({ conn, q, pais }) {
  const ax = metaAx(conn.access_token);
  const resp = await ax.get(`${GRAPH_BASE}/search`, {
    params: {
      type: 'adgeolocation',
      q,
      country_code: pais || undefined,
      location_types: JSON.stringify(['region', 'city']),
      limit: 12,
    },
  });
  const data = assertMeta(resp, 'buscar geo');
  return (data?.data || []).map((l) => ({
    key: String(l.key),
    name: l.name,
    type: l.type, // 'region' | 'city'
    region: l.region || null,
    country_code: l.country_code || null,
  }));
}

/* Mensaje de bienvenida del CTWA: lo que WhatsApp autocompleta cuando el
   cliente toca el anuncio. El formato es el del editor visual de Meta; si la
   versión de la API lo rechaza, el creativo se reintenta sin él (el anuncio
   sale igual, solo que sin autocompletar). */
function construirWelcomeMessage(texto) {
  return JSON.stringify({
    type: 'VISUAL_EDITOR',
    version: 2,
    landing_screen_type: 'welcome_message',
    media_type: 'text',
    text_format: {
      customer_action_type: 'autofill_message',
      message: {
        autofill_message: { content: texto },
        text: texto,
      },
    },
  });
}

/* Borrado best-effort de la campaña cuando un paso posterior falla: borrar la
   campaña arrastra conjuntos, creativos y anuncios hijos, y evita dejar
   basura a medias en la cuenta del cliente. */
async function eliminarCampania(ax, campaignId) {
  try {
    await ax.delete(`${GRAPH_BASE}/${campaignId}`);
  } catch (e) {
    logger.error(
      `metaAdsLauncher: no se pudo limpiar la campaña ${campaignId}: ${e.message}`,
    );
  }
}

/**
 * Crea el paquete completo. `cfg` viene normalizado desde el controller:
 * { nombre, page_id, presupuesto_diario, paises[], edad_min, edad_max,
 *   genero, titulo, texto_principal, descripcion, mensaje_bienvenida,
 *   imagen_hash, estado_inicial }
 * Devuelve { campaign_id, adset_id, creative_id, ad_id, welcome_aplicado }.
 */
async function lanzarPaquete({ conn, cfg }) {
  const ax = metaAx(conn.access_token);
  const act = ACT(conn.ad_account_id);
  const status = cfg.estado_inicial === 'ACTIVE' ? 'ACTIVE' : 'PAUSED';

  // Cada lanzamiento crea una campaña nueva; el sufijo de fecha permite
  // relanzar la misma plantilla sin chocar nombres en el Ads Manager.
  const sello = new Date()
    .toISOString()
    .slice(0, 16)
    .replace('T', ' ');
  const nombreBase = `${cfg.nombre} · ${sello}`;

  // 1) Campaña — objetivo de mensajes (CTWA)
  const campResp = await ax.post(`${GRAPH_BASE}/${act}/campaigns`, {
    name: `[ChatCenter] ${nombreBase}`,
    objective: 'OUTCOME_ENGAGEMENT',
    buying_type: 'AUCTION',
    special_ad_categories: [],
    status,
  });
  const campaign_id = assertMeta(campResp, 'crear campaña').id;

  try {
    // 2) Conjunto — presupuesto en centavos, destino WhatsApp
    const adsetResp = await ax.post(`${GRAPH_BASE}/${act}/adsets`, {
      name: nombreBase,
      campaign_id,
      daily_budget: Math.round(Number(cfg.presupuesto_diario) * 100),
      billing_event: 'IMPRESSIONS',
      optimization_goal: 'CONVERSATIONS',
      bid_strategy: 'LOWEST_COST_WITHOUT_CAP',
      destination_type: 'WHATSAPP',
      promoted_object: { page_id: cfg.page_id },
      targeting: construirTargeting(cfg),
      status,
    });
    const adset_id = assertMeta(adsetResp, 'crear conjunto').id;

    // 3-4) Un anuncio por imagen (hasta 5 variaciones dentro del mismo
    // conjunto): Meta reparte el presupuesto entre ellas y concentra el
    // gasto en el creativo ganador — la práctica estándar del Ads Manager.
    const linkDataBase = {
      link: 'https://api.whatsapp.com/send',
      message: cfg.texto_principal || '',
      name: cfg.titulo || cfg.nombre,
      call_to_action: {
        type: 'WHATSAPP_MESSAGE',
        value: { app_destination: 'WHATSAPP' },
      },
    };
    if (cfg.descripcion) linkDataBase.description = cfg.descripcion;

    const creativos = (
      Array.isArray(cfg.creativos) && cfg.creativos.length
        ? cfg.creativos
        : [{ tipo: 'imagen', hash: cfg.imagen_hash }]
    ).slice(0, 6);

    let usarWelcome = !!cfg.mensaje_bienvenida;
    const ads = [];

    for (let i = 0; i < creativos.length; i++) {
      const creativo = creativos[i];
      const sufijo = creativos.length > 1 ? ` · V${i + 1}` : '';

      // Los videos necesitan miniatura; si no llegó guardada (el video aún
      // se procesaba al subirlo), se reintenta obtenerla aquí.
      let thumbVideo = null;
      if (creativo.tipo === 'video') {
        thumbVideo =
          creativo.thumb_url ||
          (await obtenerMiniaturaVideo(conn, creativo.video_id));
      }

      const crearCreativo = async (conWelcome) => {
        let spec;
        if (creativo.tipo === 'video') {
          const vd = {
            video_id: creativo.video_id,
            image_url: thumbVideo,
            title: cfg.titulo || cfg.nombre,
            message: cfg.texto_principal || '',
            call_to_action: {
              type: 'WHATSAPP_MESSAGE',
              value: { app_destination: 'WHATSAPP' },
            },
          };
          if (cfg.descripcion) vd.link_description = cfg.descripcion;
          if (conWelcome) {
            vd.page_welcome_message = construirWelcomeMessage(
              cfg.mensaje_bienvenida,
            );
          }
          spec = { page_id: cfg.page_id, video_data: vd };
        } else {
          const ld = { ...linkDataBase };
          if (creativo.hash) ld.image_hash = creativo.hash;
          if (conWelcome) {
            ld.page_welcome_message = construirWelcomeMessage(
              cfg.mensaje_bienvenida,
            );
          }
          spec = { page_id: cfg.page_id, link_data: ld };
        }
        return ax.post(`${GRAPH_BASE}/${act}/adcreatives`, {
          name: nombreBase + sufijo,
          object_story_spec: spec,
        });
      };

      let creaResp = await crearCreativo(usarWelcome);
      if ((creaResp.status < 200 || creaResp.status >= 300) && usarWelcome) {
        logger.error(
          `metaAdsLauncher: creativo con welcome rechazado (${JSON.stringify(
            creaResp.data?.error?.message || '',
          )}); reintentando sin mensaje de bienvenida.`,
        );
        usarWelcome = false;
        creaResp = await crearCreativo(false);
      }
      const creative_id = assertMeta(creaResp, `crear creativo${sufijo}`).id;

      const adResp = await ax.post(`${GRAPH_BASE}/${act}/ads`, {
        name: nombreBase + sufijo,
        adset_id,
        creative: { creative_id },
        status,
      });
      const ad_id = assertMeta(adResp, `crear anuncio${sufijo}`).id;
      ads.push({ ad_id, creative_id });
    }

    return {
      campaign_id,
      adset_id,
      creative_id: ads[0]?.creative_id || null,
      ad_id: ads[0]?.ad_id || null,
      ads,
      welcome_aplicado: usarWelcome,
    };
  } catch (err) {
    // Si cualquier paso posterior a la campaña falla, se limpia todo el
    // paquete para que el cliente no encuentre campañas fantasma a medias.
    await eliminarCampania(ax, campaign_id);
    throw err;
  }
}

/* Páginas visibles con el token de ads, por TODOS los caminos que Meta
   ofrece. Ninguno es universal: un token de usuario clásico responde por
   me/accounts; un system user (flujo de portafolio) solo ve páginas que le
   asignaron (assigned_pages) o las del portafolio (businesses); y
   promote_pages lista las promocionables por la cuenta publicitaria. Como
   último recurso se rescatan los page_id de los anuncios ya existentes de la
   cuenta (el nombre no es legible sin permisos de páginas, pero el id sirve
   para crear el creativo). El controller mezcla esto con messenger_pages. */
async function listarPaginasDelToken(conn) {
  const ax = metaAx(conn.access_token);
  const act = ACT(conn.ad_account_id);
  const paginas = new Map(); // page_id -> { page_id, page_name, origen }

  const agregar = (lista, origen) => {
    for (const p of lista || []) {
      const id = String(p.id || '');
      if (!id) continue;
      const previa = paginas.get(id);
      // Un origen con nombre real pisa a uno sin nombre.
      if (!previa || (!previa.con_nombre && p.name)) {
        paginas.set(id, {
          page_id: id,
          page_name: p.name || `Página ${id}`,
          origen,
          con_nombre: !!p.name,
        });
      }
    }
  };

  const intentos = [
    ['promote_pages', `${GRAPH_BASE}/${act}/promote_pages`],
    ['me/accounts', `${GRAPH_BASE}/me/accounts`],
    ['assigned_pages', `${GRAPH_BASE}/me/assigned_pages`],
  ];
  for (const [origen, url] of intentos) {
    try {
      const r = await ax.get(url, { params: { fields: 'id,name', limit: 50 } });
      if (r.status >= 200 && r.status < 300) agregar(r.data?.data, origen);
    } catch (e) {
      logger.error(`metaAdsLauncher: ${origen} falló: ${e.message}`);
    }
  }

  // Páginas otorgadas en el propio token (granular_scopes de debug_token).
  // Es el camino más fiable para tokens de Login for Business: cuando la
  // configuración de login incluye el activo Páginas, los ids elegidos por
  // el cliente vienen aquí aunque me/accounts no responda.
  try {
    const dbg = await axios.get(`${GRAPH_BASE}/debug_token`, {
      params: {
        input_token: conn.access_token,
        access_token: `${FB_APP_ID}|${FB_APP_SECRET}`,
      },
      validateStatus: () => true,
      timeout: 15000,
    });
    const ids = new Set();
    for (const g of dbg.data?.data?.granular_scopes || []) {
      if (
        [
          'pages_read_engagement',
          'pages_manage_metadata',
          'pages_show_list',
          'pages_messaging',
        ].includes(g.scope)
      ) {
        for (const id of g.target_ids || []) ids.add(String(id));
      }
    }
    if (ids.size) {
      const detalles = await Promise.all(
        [...ids].map(async (id) => {
          const r = await ax.get(`${GRAPH_BASE}/${id}`, {
            params: { fields: 'id,name' },
          });
          return r.status >= 200 && r.status < 300
            ? r.data
            : { id, name: null };
        }),
      );
      agregar(detalles, 'permisos_token');
    }
  } catch (e) {
    logger.error(`metaAdsLauncher: granular pages falló: ${e.message}`);
  }

  // Por portafolio (owned + client)
  try {
    const rb = await ax.get(`${GRAPH_BASE}/me/businesses`, {
      params: { limit: 25 },
    });
    if (rb.status >= 200 && rb.status < 300) {
      for (const b of rb.data?.data || []) {
        for (const edge of ['owned_pages', 'client_pages']) {
          const r = await ax.get(`${GRAPH_BASE}/${b.id}/${edge}`, {
            params: { fields: 'id,name', limit: 50 },
          });
          if (r.status >= 200 && r.status < 300)
            agregar(r.data?.data, `business/${edge}`);
        }
      }
    }
  } catch (e) {
    logger.error(`metaAdsLauncher: businesses falló: ${e.message}`);
  }

  // Último recurso: páginas usadas en los anuncios existentes de la cuenta.
  // El token de ads siempre puede leer sus propios creativos, aunque no
  // pueda leer la página; el nombre queda genérico.
  try {
    const r = await ax.get(`${GRAPH_BASE}/${act}/ads`, {
      params: { fields: 'creative{object_story_spec}', limit: 50 },
    });
    if (r.status >= 200 && r.status < 300) {
      const vistos = [];
      for (const a of r.data?.data || []) {
        const pid = a.creative?.object_story_spec?.page_id;
        if (pid) vistos.push({ id: pid, name: null });
      }
      agregar(vistos, 'ads_existentes');
    }
  } catch (e) {
    logger.error(`metaAdsLauncher: ads existentes falló: ${e.message}`);
  }

  return [...paginas.values()].map(({ con_nombre, ...p }) => p);
}

/* Quién es el dueño del token (usuario o system user). Sirve para guiar la
   asignación de la página: Meta no permite asignar activos a un system user
   por API, así que el front muestra el nombre exacto a buscar en el
   Business Manager. */
async function obtenerTitularToken(conn) {
  try {
    const ax = metaAx(conn.access_token);
    const r = await ax.get(`${GRAPH_BASE}/me`, {
      params: { fields: 'id,name' },
    });
    if (r.status >= 200 && r.status < 300) {
      return { id: String(r.data?.id || ''), name: r.data?.name || null };
    }
  } catch (e) {
    logger.error(`metaAdsLauncher: me falló: ${e.message}`);
  }
  return null;
}

module.exports = {
  subirImagen,
  subirVideo,
  obtenerMiniaturaVideo,
  lanzarPaquete,
  listarPaginasDelToken,
  obtenerTitularToken,
  buscarGeo,
};
