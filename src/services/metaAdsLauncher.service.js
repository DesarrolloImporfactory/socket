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
const fs = require('fs');
const logger = require('../utils/logger');

// La app se resuelve por conexión (meta_ad_connections.fb_app_id), no por
// entorno: las conexiones anteriores a la app nueva tienen la columna en NULL
// y resolveApp las manda a la app histórica, que es la que emitió su token.
const { resolveApp } = require('../config/metaApps');
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
/* Subida RESUMIBLE por trozos (protocolo start / transfer / finish de
   act_X/advideos). Meta dicta el tamaño de cada trozo (start_offset →
   end_offset) y aquí se lee solo ese tramo del temporal en disco, así la
   memoria del servidor queda acotada al trozo aunque el video pese 300 MB
   (axios serializa el FormData completo en memoria: por eso NO se manda el
   archivo entero de una). Cada trozo se reintenta hasta 3 veces. Se acepta
   `buffer` por compatibilidad con el endpoint viejo. */
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

async function subirVideo({ conn, filePath, buffer, filename, mimetype }) {
  const act = ACT(conn.ad_account_id);
  const url = `https://graph-video.facebook.com/${process.env.GRAPH_VERSION}/${act}/advideos`;
  const post = (data) =>
    axios.post(url, data, {
      headers: { Authorization: `Bearer ${conn.access_token}` },
      timeout: 600000,
      maxBodyLength: Infinity,
      validateStatus: () => true,
    });
  const tipo = mimetype || 'video/mp4';
  const nombre = filename || 'video.mp4';
  const size = filePath ? fs.statSync(filePath).size : buffer.length;

  // 1) start → sesión + video_id + primer tramo
  const inicio = assertMeta(
    await post(
      new URLSearchParams({ upload_phase: 'start', file_size: String(size) }),
    ),
    'advideos start',
  );
  const { upload_session_id, video_id } = inicio;
  let startOffset = Number(inicio.start_offset);
  let endOffset = Number(inicio.end_offset);
  if (!upload_session_id || !video_id) {
    const err = new Error('Meta no abrió la sesión de subida del video.');
    err.meta_error = inicio;
    throw err;
  }

  // 2) transfer → un tramo por vuelta hasta que Meta devuelve start == end
  const fd = filePath ? fs.openSync(filePath, 'r') : null;
  try {
    while (startOffset < endOffset) {
      const len = endOffset - startOffset;
      let trozo;
      if (fd !== null) {
        trozo = Buffer.alloc(len);
        fs.readSync(fd, trozo, 0, len, startOffset);
      } else {
        trozo = buffer.subarray(startOffset, endOffset);
      }
      let resp;
      for (let intento = 1; intento <= 3; intento++) {
        const form = new FormData();
        form.append('upload_phase', 'transfer');
        form.append('upload_session_id', String(upload_session_id));
        form.append('start_offset', String(startOffset));
        form.append('video_file_chunk', new Blob([trozo], { type: tipo }), nombre);
        resp = await post(form);
        if (resp.status >= 200 && resp.status < 300) break;
        logger.error(
          `subirVideo: tramo ${startOffset}-${endOffset} falló (intento ${intento}): ${JSON.stringify(
            resp.data?.error?.message || resp.status,
          )}`,
        );
        if (intento < 3) await esperar(1500 * intento);
      }
      const data = assertMeta(resp, `advideos transfer @${startOffset}`);
      startOffset = Number(data.start_offset);
      endOffset = Number(data.end_offset);
    }
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }

  // 3) finish
  const fin = assertMeta(
    await post(
      new URLSearchParams({
        upload_phase: 'finish',
        upload_session_id: String(upload_session_id),
        title: nombre.slice(0, 100),
      }),
    ),
    'advideos finish',
  );
  if (!fin?.success) {
    const err = new Error('Meta no confirmó el cierre de la subida del video.');
    err.meta_error = fin;
    throw err;
  }
  return { video_id: String(video_id) };
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
    // Sin espera tras el último intento: quien llama decide si reintenta
    // (el front la vuelve a pedir en segundo plano; el lanzamiento la exige).
    if (i < intentos - 1) await new Promise((res) => setTimeout(res, 3000));
  }
  return null;
}

/* Fuente reproducible + miniatura de un video de la cuenta. `source` es un
   enlace temporal del CDN de Meta (dura horas, no días): se pide cada vez
   que se abre la vista previa y no se guarda en la plantilla. */
async function obtenerInfoVideo(conn, video_id) {
  const ax = metaAx(conn.access_token);
  const r = await ax.get(`${GRAPH_BASE}/${video_id}`, {
    params: { fields: 'source,picture,status,length' },
  });
  const data = assertMeta(r, 'video info');
  return {
    video_id: String(video_id),
    source: data?.source || null,
    picture: data?.picture || null,
    status: data?.status?.video_status || null,
    length: data?.length || null,
  };
}

/* Offset UTC de la zona horaria de la cuenta publicitaria (ej. "-05:00"
   para America/Guayaquil). La hora programada se interpreta en la hora
   local del cliente, no en UTC. */
function offsetDeZona(timeZone) {
  try {
    const dtf = new Intl.DateTimeFormat('en-US', {
      timeZone,
      timeZoneName: 'longOffset',
    });
    const parte =
      dtf.formatToParts(new Date()).find((p) => p.type === 'timeZoneName')
        ?.value || '';
    const m = /GMT([+-]\d{2}:\d{2})/.exec(parte);
    if (m) return m[1];
    if (/^GMT$/.test(parte.trim())) return '+00:00';
  } catch {}
  return '-05:00';
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

  // Zonas excluidas (provincias/ciudades): "todo el país menos X".
  let excluded_geo_locations;
  const excluir = Array.isArray(geo.excluir) ? geo.excluir : [];
  if (excluir.length) {
    const exRegions = excluir
      .filter((l) => l.type === 'region')
      .map((l) => ({ key: String(l.key) }));
    const exCities = excluir
      .filter((l) => l.type === 'city')
      .map((l) => ({ key: String(l.key) }));
    excluded_geo_locations = {};
    if (exRegions.length) excluded_geo_locations.regions = exRegions;
    if (exCities.length) excluded_geo_locations.cities = exCities;
  }

  const targeting = {
    geo_locations,
    ...(excluded_geo_locations ? { excluded_geo_locations } : {}),
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
async function buscarGeo({ conn, q, pais, limit = 12 }) {
  const ax = metaAx(conn.access_token);
  const resp = await ax.get(`${GRAPH_BASE}/search`, {
    params: {
      type: 'adgeolocation',
      q,
      country_code: pais || undefined,
      location_types: JSON.stringify(['region', 'city']),
      limit,
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

/* Resolución MASIVA de zonas: el cliente pega una lista de nombres (una
   provincia/estado o ciudad por línea — México excluye decenas de zonas sin
   cobertura) y cada nombre se busca en Meta eligiendo la mejor coincidencia:
   nombre exacto (sin tildes ni mayúsculas) con preferencia por región sobre
   ciudad; si no hay exacta, el único resultado o el que empieza igual. Lo que
   no se resuelve vuelve como no_encontrados con sugerencias para corregir. */
const normalizarBasico = (s) =>
  String(s || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
const normalizarNombreGeo = (s) =>
  normalizarBasico(s)
    .replace(/\b(provincia|estado|departamento|region|de|del|la|el|los|las)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
// Nombres que el cliente escribe en español y Meta indexa en inglés u otra
// forma. Clave = nombre normalizado (normalizarBasico); valor = q para Meta.
const ALIAS_GEO = {
  'ciudad de mexico': 'Mexico City',
  cdmx: 'Mexico City',
  'distrito federal': 'Mexico City',
  // Meta llama "México" a la región del Estado de México.
  'estado de mexico': 'México',
  edomex: 'México',
  michoacan: 'Michoacán de Ocampo',
  'nuevo leon': 'Nuevo León',
  'baja california norte': 'Baja California',
};

async function resolverGeoMasivo({ conn, nombres, pais, concurrencia = 5 }) {
  const consultas = [
    ...new Set(
      (nombres || []).map((n) => String(n || '').trim()).filter(Boolean),
    ),
  ].slice(0, 250);
  const encontrados = [];
  const no_encontrados = [];
  const vistos = new Set();

  // Para ciudades el nombre visible lleva su estado/provincia: hay ciudades
  // homónimas (Monterrey en Nuevo León y en Tamaulipas) y así el cliente ve
  // cuál se eligió y corrige si hace falta.
  const conRegion = (r) =>
    r.type === 'city' && r.region && !r.name.includes(',')
      ? { ...r, name: `${r.name}, ${r.region}` }
      : r;

  const resolverUno = async (consulta) => {
    const crudo = normalizarBasico(consulta);
    const q = ALIAS_GEO[crudo] || consulta;
    let resultados = [];
    try {
      // Límite amplio: con 12 resultados la ciudad grande homónima puede
      // quedar fuera (Monterrey NL detrás de los Monterrey chicos).
      resultados = await buscarGeo({ conn, q, pais, limit: 30 });
    } catch (e) {
      logger.error(`resolverGeoMasivo "${consulta}": ${e.message}`);
    }
    const objetivo = normalizarNombreGeo(q);
    // Meta a veces mete el estado en el propio nombre ("Monterrey, Nuevo
    // Leon"): la parte antes de la coma también cuenta como nombre exacto.
    const cand = resultados.map((r) => ({
      r,
      n: normalizarNombreGeo(r.name),
      nb: normalizarBasico(r.name),
      nbBase: normalizarBasico(String(r.name).split(',')[0]),
    }));
    const exacta = (c) =>
      c.n === objetivo || c.nb === objetivo || c.nbBase === objetivo;
    const parecida = (c) =>
      exacta(c) || c.n.startsWith(objetivo) || objetivo.startsWith(c.n);
    const regiones = cand.filter((c) => c.r.type === 'region');
    const ciudadesExactas = cand.filter((c) => c.r.type === 'city' && exacta(c));
    // En listas de cobertura el cliente habla de estados/provincias: si hay
    // una región que coincide, gana sobre la ciudad homónima ("Michoacán"
    // es el estado, no el pueblo de Tabasco).
    const region = regiones.find(exacta)?.r || regiones.find(parecida)?.r;
    if (!region && ciudadesExactas.length > 1) {
      // Ciudades homónimas en distintos estados (Monterrey NL / Tamaulipas):
      // no se adivina — el cliente elige entre las coincidencias.
      no_encontrados.push({
        consulta,
        ambigua: true,
        sugerencias: ciudadesExactas.slice(0, 4).map((c) => conRegion(c.r)),
      });
      return;
    }
    const elegido =
      region ||
      ciudadesExactas[0]?.r ||
      (resultados.length === 1 ? resultados[0] : null) ||
      cand.find(parecida)?.r ||
      null;
    if (elegido && !vistos.has(elegido.key)) {
      vistos.add(elegido.key);
      encontrados.push({ ...conRegion(elegido), consulta });
    } else if (!elegido) {
      no_encontrados.push({
        consulta,
        sugerencias: resultados.slice(0, 4).map(conRegion),
      });
    }
  };

  // Pool sencillo: N búsquedas a la vez para no disparar el rate limit.
  let idx = 0;
  const worker = async () => {
    while (idx < consultas.length) {
      const i = idx++;
      await resolverUno(consultas[i]);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrencia, consultas.length) }, worker),
  );
  // Se devuelve en el orden en que el cliente escribió la lista.
  const orden = new Map(consultas.map((c, i) => [c, i]));
  encontrados.sort((a, b) => orden.get(a.consulta) - orden.get(b.consulta));
  return { encontrados, no_encontrados, total: consultas.length };
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
  // Sin número de WhatsApp de la cuenta no se crea NADA: todo el embudo
  // (bot, atribución, cierre) depende de que los mensajes entren por él.
  if (!cfg.whatsapp?.numero) {
    const err = new Error(
      'La cuenta no tiene un número de WhatsApp conectado; el lanzador no crea campañas sin él.',
    );
    err.paso = 'número de WhatsApp';
    throw err;
  }
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
    // El presupuesto vive en el conjunto (no hay presupuesto de campaña / CBO).
    // Desde Graph v25 Meta exige declarar este flag en ese caso; con un solo
    // conjunto por campaña el reparto entre conjuntos no aplica -> false.
    is_adset_budget_sharing_enabled: false,
    status,
  });
  const campaign_id = assertMeta(campResp, 'crear campaña').id;

  try {
    // 2) Conjunto — presupuesto en centavos, destino WhatsApp.
    // El número de WhatsApp va EXPLÍCITO: con solo page_id Meta usa el número
    // que la página tenga vinculado por defecto, y si la página tiene otro
    // (caso México 2026-09-21) la campaña sale hacia un número ajeno al bot.
    // Si el número no está vinculado a la cuenta, Meta rechaza el conjunto
    // (subcode 1487246) y no se crea nada — ese es el comportamiento deseado.
    // OJO: solo `whatsapp_phone_number`. Mandar además
    // `whats_app_business_phone_number_id` hace que Meta responda
    // "(#200) Permissions error" aunque cada campo por separado sea válido
    // (probado con validate_only en las cuentas 610 y 822 el 2026-09-23).
    const adsetPayload = {
      name: nombreBase,
      campaign_id,
      daily_budget: Math.round(Number(cfg.presupuesto_diario) * 100),
      billing_event: 'IMPRESSIONS',
      optimization_goal: 'CONVERSATIONS',
      bid_strategy: 'LOWEST_COST_WITHOUT_CAP',
      destination_type: 'WHATSAPP',
      promoted_object: {
        page_id: cfg.page_id,
        whatsapp_phone_number: cfg.whatsapp.numero,
      },
      targeting: construirTargeting(cfg),
      status,
    };
    // Programación: si hay hora de inicio futura, el conjunto arranca solo
    // a esa hora (hora local de la cuenta publicitaria). Meta la respeta
    // aunque la campaña ya esté activa y aprobada.
    if (cfg.inicio_at) {
      adsetPayload.start_time = `${String(cfg.inicio_at).replace(' ', 'T')}${offsetDeZona(conn.timezone_name)}`;
    }
    const adsetResp = await ax.post(`${GRAPH_BASE}/${act}/adsets`, adsetPayload);
    const adset_id = assertMeta(adsetResp, 'crear conjunto').id;

    // Doble seguro: se relee el conjunto y, si Meta devuelve un número de
    // WhatsApp distinto al de la cuenta, se aborta (el catch borra la
    // campaña). Si el campo no viene en la respuesta no se puede comparar y
    // se confía en que Meta ya validó el número al crear el conjunto.
    const verif = await ax.get(`${GRAPH_BASE}/${adset_id}`, {
      params: { fields: 'promoted_object' },
    });
    const numeroMeta = String(
      verif.data?.promoted_object?.whatsapp_phone_number || '',
    ).replace(/\D/g, '');
    const numeroCfg = String(cfg.whatsapp.numero).replace(/\D/g, '');
    if (numeroMeta && numeroMeta !== numeroCfg) {
      const err = new Error(
        `Meta asignó al conjunto el WhatsApp +${numeroMeta} y no el de la cuenta (+${numeroCfg}).`,
      );
      err.paso = 'verificar número de WhatsApp';
      err.meta_error = {
        message: err.message,
        whatsapp_meta: numeroMeta,
        whatsapp_cuenta: numeroCfg,
      };
      throw err;
    }

    // 3-4) Un anuncio por creativo (hasta 10 variaciones dentro del mismo
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
    ).slice(0, 10);

    let usarWelcome = !!cfg.mensaje_bienvenida;
    const ads = [];

    for (let i = 0; i < creativos.length; i++) {
      const creativo = creativos[i];
      const sufijo = creativos.length > 1 ? ` · V${i + 1}` : '';

      // Los videos necesitan miniatura y se pide SIEMPRE fresca aquí: la que
      // pudo guardarse al subir suele ser el cuadro gris de "procesando" de
      // Meta, y con esa el anuncio saldría con portada gris. La guardada
      // queda solo como último recurso.
      let thumbVideo = null;
      if (creativo.tipo === 'video') {
        thumbVideo =
          (await obtenerMiniaturaVideo(conn, creativo.video_id)) ||
          creativo.thumb_url ||
          null;
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
      whatsapp_numero: cfg.whatsapp.numero,
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

  /* Todos los caminos se consultan EN PARALELO (en serie eran ~8 llamadas a
     Graph y el contexto tardaba varios segundos). El merge respeta la
     prioridad: cualquier fuente con nombre real pisa a los ids genéricos
     rescatados de anuncios existentes. */
  const buscarSimple = async (origen, url) => {
    try {
      const r = await ax.get(url, { params: { fields: 'id,name', limit: 50 } });
      if (r.status >= 200 && r.status < 300)
        return { origen, lista: r.data?.data || [] };
    } catch (e) {
      logger.error(`metaAdsLauncher: ${origen} falló: ${e.message}`);
    }
    return { origen, lista: [] };
  };

  // Páginas otorgadas en el propio token (granular_scopes de debug_token).
  // Es el camino más fiable para tokens de Login for Business: cuando la
  // configuración de login incluye el activo Páginas, los ids elegidos por
  // el cliente vienen aquí aunque me/accounts no responda.
  const buscarGranular = async () => {
    try {
      const dbg = await axios.get(`${GRAPH_BASE}/debug_token`, {
        params: {
          input_token: conn.access_token,
          // Token de app de la MISMA app que emitió conn.access_token.
          access_token: resolveApp(conn.fb_app_id).appAccessToken,
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
        return { origen: 'permisos_token', lista: detalles };
      }
    } catch (e) {
      logger.error(`metaAdsLauncher: granular pages falló: ${e.message}`);
    }
    return { origen: 'permisos_token', lista: [] };
  };

  // Por portafolio (owned + client), con los edges en paralelo
  const buscarBusinesses = async () => {
    try {
      const rb = await ax.get(`${GRAPH_BASE}/me/businesses`, {
        params: { limit: 25 },
      });
      if (rb.status >= 200 && rb.status < 300) {
        const tareas = [];
        for (const b of rb.data?.data || []) {
          for (const edge of ['owned_pages', 'client_pages']) {
            tareas.push(
              ax
                .get(`${GRAPH_BASE}/${b.id}/${edge}`, {
                  params: { fields: 'id,name', limit: 50 },
                })
                .then((r) =>
                  r.status >= 200 && r.status < 300 ? r.data?.data || [] : [],
                )
                .catch(() => []),
            );
          }
        }
        const listas = await Promise.all(tareas);
        return { origen: 'business', lista: listas.flat() };
      }
    } catch (e) {
      logger.error(`metaAdsLauncher: businesses falló: ${e.message}`);
    }
    return { origen: 'business', lista: [] };
  };

  // Último recurso: páginas usadas en los anuncios existentes de la cuenta.
  // El token de ads siempre puede leer sus propios creativos, aunque no
  // pueda leer la página; el nombre queda genérico.
  const buscarAdsExistentes = async () => {
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
        return { origen: 'ads_existentes', lista: vistos };
      }
    } catch (e) {
      logger.error(`metaAdsLauncher: ads existentes falló: ${e.message}`);
    }
    return { origen: 'ads_existentes', lista: [] };
  };

  const resultados = await Promise.all([
    buscarSimple('promote_pages', `${GRAPH_BASE}/${act}/promote_pages`),
    buscarSimple('me/accounts', `${GRAPH_BASE}/me/accounts`),
    buscarSimple('assigned_pages', `${GRAPH_BASE}/me/assigned_pages`),
    buscarGranular(),
    buscarBusinesses(),
    buscarAdsExistentes(),
  ]);
  for (const r of resultados) agregar(r.lista, r.origen);

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


/* ══════════════════════════════════════════════
   CENTRO DE CAMPAÑAS — lectura de la cuenta completa
   ══════════════════════════════════════════════
   La vista /anuncios muestra TODAS las campañas de la cuenta publicitaria
   (las lanzadas desde aquí y las creadas en el Ads Manager) con sus métricas
   del período. Antes solo se veían plantillas + historial y el cliente no
   tenía cómo saber qué campañas existían ni aplicarles reglas.

   Rango de fechas: SIEMPRE time_range {since, until} con `until` = hoy, el
   mismo criterio que conexion-dashboard?view=ads. Los presets de Meta
   (last_7d, etc.) excluyen el día de hoy y los números no cuadraban entre
   las dos vistas (35.21 vs 29.36 en la 610). */

const FECHA_ISO = /^\d{4}-\d{2}-\d{2}$/;

function fechaLocalISO(diasAtras = 0) {
  const d = new Date();
  d.setDate(d.getDate() - diasAtras);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/* Normaliza {since, until}: si falta o viene mal, últimos 7 días hasta hoy
   (el default del dashboard). */
function rangoDeFechas({ since, until } = {}) {
  const u = FECHA_ISO.test(until || '') ? until : fechaLocalISO(0);
  let s = FECHA_ISO.test(since || '') ? since : fechaLocalISO(7);
  if (s > u) s = u;
  return { since: s, until: u };
}

/* Recorre paging.next hasta `maxPaginas` páginas. `paging.next` ya trae los
   query params, así que a partir de la segunda página van sin `params`. */
async function leerPaginado(ax, url, params, label, maxPaginas = 5) {
  const filas = [];
  let siguiente = url;
  let p = params;
  for (let i = 0; i < maxPaginas && siguiente; i++) {
    const resp = await ax.get(siguiente, p ? { params: p } : undefined);
    const data = assertMeta(resp, label);
    filas.push(...(data.data || []));
    siguiente = data.paging?.next || null;
    p = null;
  }
  return filas;
}

function contarMensajes(actions) {
  if (!Array.isArray(actions)) return 0;
  let total = 0;
  for (const a of actions) {
    if (a.action_type === 'onsite_conversion.messaging_conversation_started_7d')
      total += Number(a.value) || 0;
  }
  return total;
}

function contarCompras(actions) {
  if (!Array.isArray(actions)) return 0;
  let total = 0;
  for (const a of actions) {
    if (a.action_type === 'purchase') total += Number(a.value) || 0;
  }
  return total;
}

function resumirInsight(row) {
  const spend = Number(row?.spend) || 0;
  const msgs = contarMensajes(row?.actions);
  return {
    spend: +spend.toFixed(2),
    impressions: Number(row?.impressions) || 0,
    clicks: Number(row?.clicks) || 0,
    msgs,
    cpa_msg: msgs > 0 ? +(spend / msgs).toFixed(2) : null,
    purchases: contarCompras(row?.actions),
  };
}

// Miniatura del creativo a 320px (el default de Meta es 64px y se ve
// pixelada en los cards).
const CREATIVO_THUMB =
  'creative.thumbnail_width(320).thumbnail_height(320){thumbnail_url,image_url,title,body}';

const CAMPOS_CAMPANIA = [
  'id',
  'name',
  'status',
  'effective_status',
  'objective',
  'daily_budget',
  'lifetime_budget',
  'created_time',
  'start_time',
  'stop_time',
  'updated_time',
  // El primer anuncio da la imagen de la campaña (sistema o externa).
  `ads.limit(1){${CREATIVO_THUMB}}`,
].join(',');

/* Campañas de la cuenta (sin las eliminadas ni archivadas) + insights del
   rango a nivel campaña. Dos llamadas paginadas en paralelo; la de insights
   solo trae las campañas con actividad, el resto queda en cero. */
async function listarCampaniasCuenta({ conn, since, until }) {
  const ax = metaAx(conn.access_token);
  const act = ACT(conn.ad_account_id);
  const rango = rangoDeFechas({ since, until });
  // La tercera llamada (nivel cuenta) es la MISMA que usa el dashboard:
  // sus totales mandan en los KPIs para que ambas vistas digan lo mismo
  // (la suma por campaña difiere centavos por redondeo de Meta).
  const [campanias, insights, cuentaResp] = await Promise.all([
    leerPaginado(
      ax,
      `${GRAPH_BASE}/${act}/campaigns`,
      {
        fields: CAMPOS_CAMPANIA,
        // Meta incluye ARCHIVED por defecto; DELETED nunca. Solo lo vivo.
        effective_status: JSON.stringify([
          'ACTIVE',
          'PAUSED',
          'PENDING_REVIEW',
          'DISAPPROVED',
          'PREAPPROVED',
          'PENDING_BILLING_INFO',
          'CAMPAIGN_PAUSED',
          'ADSET_PAUSED',
          'IN_PROCESS',
          'WITH_ISSUES',
        ]),
        limit: 200,
      },
      'campaigns',
    ),
    leerPaginado(
      ax,
      `${GRAPH_BASE}/${act}/insights`,
      {
        level: 'campaign',
        fields: 'campaign_id,spend,impressions,clicks,actions',
        time_range: JSON.stringify(rango),
        limit: 500,
      },
      'insights_campaigns',
    ),
    ax.get(`${GRAPH_BASE}/${act}/insights`, {
      params: {
        fields: 'spend,impressions,clicks,actions',
        time_range: JSON.stringify(rango),
      },
    }),
  ]);

  const porCampania = new Map();
  for (const row of insights) porCampania.set(String(row.campaign_id), row);

  const cuentaRow =
    cuentaResp.status >= 200 && cuentaResp.status < 300
      ? cuentaResp.data?.data?.[0] || null
      : null;

  return {
    rango,
    cuenta: cuentaRow ? resumirInsight(cuentaRow) : null,
    campanias: campanias.map((c) => {
      const creativo = c.ads?.data?.[0]?.creative || null;
      return {
        id: String(c.id),
        name: c.name,
        status: c.status,
        effective_status: c.effective_status,
        objective: c.objective || null,
        daily_budget: c.daily_budget ? Number(c.daily_budget) / 100 : null,
        lifetime_budget: c.lifetime_budget
          ? Number(c.lifetime_budget) / 100
          : null,
        created_time: c.created_time || null,
        start_time: c.start_time || null,
        stop_time: c.stop_time || null,
        thumbnail_url: creativo?.thumbnail_url || creativo?.image_url || null,
        ...resumirInsight(porCampania.get(String(c.id))),
      };
    }),
  };
}

/* Anuncios de una campaña con su creativo (miniatura) e insights del
   rango. Sirve para el detalle de la campaña: ver qué variación gasta y
   cuál trae mensajes, y pausar/activar cada una. */
async function listarAnunciosCampania({ conn, campaign_id, since, until }) {
  const ax = metaAx(conn.access_token);
  const rango = rangoDeFechas({ since, until });
  const filas = await leerPaginado(
    ax,
    `${GRAPH_BASE}/${campaign_id}/ads`,
    {
      fields: [
        'id',
        'name',
        'status',
        'effective_status',
        'adset_id',
        'created_time',
        CREATIVO_THUMB,
        `insights.time_range(${JSON.stringify(rango)}){spend,impressions,clicks,actions}`,
      ].join(','),
      limit: 100,
    },
    'campaign_ads',
    3,
  );
  return {
    rango,
    anuncios: filas
      .filter((a) => !['DELETED', 'ARCHIVED'].includes(a.effective_status))
      .map((a) => ({
        id: String(a.id),
        name: a.name,
        status: a.status,
        effective_status: a.effective_status,
        adset_id: a.adset_id ? String(a.adset_id) : null,
        created_time: a.created_time || null,
        thumbnail_url:
          a.creative?.thumbnail_url || a.creative?.image_url || null,
        titulo: a.creative?.title || null,
        texto: a.creative?.body || null,
        ...resumirInsight(a.insights?.data?.[0]),
      })),
  };
}

/* Estado actual de campañas puntuales (las lanzadas desde aquí que ya no
   salen en el listado: archivadas o eliminadas en el Ads Manager). Una
   sola llamada con ?ids=. Devuelve Map id -> effective_status; si Meta
   falla se devuelve vacío y el front las muestra como "ya no está". */
async function estadoDeCampanias({ conn, ids }) {
  const out = new Map();
  const lista = [...new Set((ids || []).map(String))].slice(0, 50);
  if (!lista.length) return out;
  try {
    const ax = metaAx(conn.access_token);
    const resp = await ax.get(`${GRAPH_BASE}/`, {
      params: { ids: lista.join(','), fields: 'id,effective_status' },
    });
    if (resp.status >= 200 && resp.status < 300) {
      for (const id of lista) {
        const v = resp.data?.[id];
        out.set(id, v?.effective_status || (v?.error ? 'DELETED' : null));
      }
      return out;
    }
    // Un solo id eliminado hace fallar el lote completo: se consultan de a
    // uno (pocos: solo lo lanzado desde aquí que ya no está vivo).
    for (const id of lista.slice(0, 10)) {
      const r = await ax.get(`${GRAPH_BASE}/${id}`, {
        params: { fields: 'id,effective_status' },
      });
      out.set(
        id,
        r.status >= 200 && r.status < 300
          ? r.data?.effective_status || null
          : 'DELETED',
      );
    }
  } catch (err) {
    logger.error(`estadoDeCampanias: ${err.message}`);
  }
  return out;
}

module.exports = {
  listarCampaniasCuenta,
  listarAnunciosCampania,
  estadoDeCampanias,
  subirImagen,
  subirVideo,
  obtenerMiniaturaVideo,
  obtenerInfoVideo,
  lanzarPaquete,
  listarPaginasDelToken,
  obtenerTitularToken,
  buscarGeo,
  resolverGeoMasivo,
};
