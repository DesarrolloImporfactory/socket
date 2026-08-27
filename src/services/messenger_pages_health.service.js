/**
 * messenger_pages_health.service.js
 *
 * Verifica que los page_access_token de `messenger_pages` sigan sirviendo.
 *
 * Por qué existe: `messenger_pages.status` es enum('active','revoked') pero
 * ningún punto del código lo pasa a 'revoked' cuando Meta invalida el token.
 * La fila se queda 'active' para siempre y `getPageTokenByPageId()`
 * (messenger.service.js) sigue entregando un token muerto filtrando justamente
 * por status='active'. Los webhooks entrantes siguen llegando —no usan token—
 * pero todo envío saliente falla en silencio y nadie se entera.
 *
 * Además de la validez, se comprueba si la página puede leer su propio feed.
 * Eso es prerequisito del módulo de comentarios de Facebook: sin
 * pages_read_engagement no se pueden listar publicaciones ni comentarios.
 */

const axios = require('axios');
const crypto = require('crypto');
const { db } = require('../database/config');

const GRAPH_VERSION = process.env.GRAPH_VERSION || 'v22.0';
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_VERSION}`;
const FB_APP_ID = process.env.FB_APP_ID;
const FB_APP_SECRET = process.env.FB_APP_SECRET;

const APP_TOKEN = () => `${FB_APP_ID}|${FB_APP_SECRET}`;

function appsecretProof(accessToken) {
  if (!FB_APP_SECRET) return null;
  return crypto
    .createHmac('sha256', FB_APP_SECRET)
    .update(accessToken)
    .digest('hex');
}

/**
 * Vigila el cupo de Graph leyendo las cabeceras que Meta devuelve en cada
 * respuesta.
 *
 * `X-App-Usage.call_count` es el % (0-100) del cupo horario de TODA la app, no
 * de este servicio: lo comparten WhatsApp, Meta Ads, los perfiles de página y
 * todo lo demás. Al 100% Meta bloquea temporalmente y se cae todo, no solo este
 * chequeo. Medido el 2026-08-27 el balde iba al 25% en reposo.
 *
 * Solo avisa: no frena nada, porque el volumen propio es de decenas de llamadas
 * al día. Sirve para que quede rastro en los logs si algún día alguien pone
 * esto en un bucle.
 */
function vigilarCupo(headers, etiqueta) {
  try {
    const uso = headers?.['x-app-usage'];
    if (!uso) return;
    const { call_count = 0 } = JSON.parse(uso);
    if (call_count >= 80) {
      console.warn(
        `[MS][HEALTH][CUPO] X-App-Usage al ${call_count}% tras ${etiqueta}. ` +
          `Al 100% Meta bloquea temporalmente TODA la app.`,
      );
    }
  } catch {
    /* cabecera ausente o ilegible: no es motivo para romper el chequeo */
  }
}

/**
 * Códigos de Meta que significan "este token ya no sirve, punto".
 * 190 = OAuthException token inválido/expirado/sesión invalidada.
 * 102 = sesión caducada.
 * Cualquier otra cosa (timeouts, 500 de Meta, rate limit 4/17/32) es
 * transitoria y NO debe marcar la conexión como revocada.
 */
const CODIGOS_TOKEN_MUERTO = new Set([190, 102]);

/**
 * Llama a debug_token con reintentos.
 *
 * Distinguir "Meta dijo que el token está muerto" de "no pude preguntar" es lo
 * único que importa acá: un timeout tratado como token inválido revoca
 * conexiones sanas y obliga al cliente a reconectar sin motivo. Por eso el
 * retorno separa `concluyente` de `valido`.
 */
async function inspeccionarToken(token, { intentos = 3 } = {}) {
  let ultimoError = null;

  for (let i = 0; i < intentos; i++) {
    try {
      const r = await axios.get(`${GRAPH_BASE}/debug_token`, {
        params: { input_token: token, access_token: APP_TOKEN() },
        validateStatus: () => true,
        timeout: 20000,
      });

      vigilarCupo(r.headers, 'debug_token');

      const d = r.data?.data;
      if (r.status === 200 && d) {
        return {
          concluyente: true,
          valido: d.is_valid === true,
          tipo: d.type || null,
          scopes: d.scopes || [],
          error: d.error?.message || null,
          codigo: d.error?.code ?? null,
          expira: d.expires_at ? new Date(d.expires_at * 1000) : null,
        };
      }

      const err = r.data?.error;
      if (err) {
        // Meta contestó con un error explícito sobre el token.
        if (CODIGOS_TOKEN_MUERTO.has(Number(err.code))) {
          return {
            concluyente: true,
            valido: false,
            tipo: null,
            scopes: [],
            error: err.message || 'Token inválido',
            codigo: Number(err.code),
            expira: null,
          };
        }
        ultimoError = err.message || `HTTP ${r.status}`;
      } else {
        ultimoError = `HTTP ${r.status}`;
      }
    } catch (e) {
      ultimoError = e.message;
    }

    // Backoff corto: 1s, 2s.
    if (i < intentos - 1) {
      await new Promise((r) => setTimeout(r, 1000 * (i + 1)));
    }
  }

  return {
    concluyente: false,
    valido: null,
    tipo: null,
    scopes: [],
    error: ultimoError || 'sin respuesta de Meta',
    codigo: null,
    expira: null,
  };
}

/**
 * ¿Puede esta página leer su propio feed? Es la prueba real de
 * pages_read_engagement, que es lo que necesitará el módulo de comentarios.
 * Nunca lanza: si falla se devuelve false con el motivo.
 */
async function puedeLeerFeed(pageId, token) {
  try {
    const proof = appsecretProof(token);
    const r = await axios.get(`${GRAPH_BASE}/${pageId}/feed`, {
      params: {
        fields: 'id',
        limit: 1,
        access_token: token,
        ...(proof ? { appsecret_proof: proof } : {}),
      },
      validateStatus: () => true,
      timeout: 20000,
    });
    if (r.status === 200) return { ok: true, motivo: null };
    return {
      ok: false,
      motivo: r.data?.error?.message || `HTTP ${r.status}`,
    };
  } catch (e) {
    return { ok: false, motivo: e.message };
  }
}

/** Revisa UNA página y devuelve el diagnóstico (sin escribir en BD). */
async function revisarPagina(pagina) {
  const base = {
    id_messenger_page: pagina.id_messenger_page,
    id_configuracion: pagina.id_configuracion,
    page_id: pagina.page_id,
    page_name: pagina.page_name,
    status: pagina.status,
  };

  if (!pagina.page_access_token) {
    return {
      ...base,
      concluyente: true,
      token_valido: false,
      token_error: 'La conexión no tiene page_access_token guardado',
      scopes: [],
      puede_leer_feed: false,
      feed_error: null,
    };
  }

  const info = await inspeccionarToken(pagina.page_access_token);

  // Si no se pudo concluir, se reporta pero NO se toca el estado.
  if (!info.concluyente) {
    return {
      ...base,
      concluyente: false,
      token_valido: null,
      token_error: info.error,
      scopes: [],
      puede_leer_feed: null,
      feed_error: null,
    };
  }

  if (!info.valido) {
    return {
      ...base,
      concluyente: true,
      token_valido: false,
      token_error: info.error || 'Token inválido',
      scopes: info.scopes,
      puede_leer_feed: false,
      feed_error: null,
    };
  }

  const feed = await puedeLeerFeed(pagina.page_id, pagina.page_access_token);

  return {
    ...base,
    concluyente: true,
    token_valido: true,
    token_error: null,
    scopes: info.scopes,
    puede_leer_feed: feed.ok,
    feed_error: feed.motivo,
  };
}

/**
 * Persiste el diagnóstico.
 *
 * ⚠️ `marcarRevoked` viene en false a propósito. Poner status='revoked' NO es
 * un cambio cosmético: `status` está sobrecargado y lo usan al menos
 *
 *   - `getConfigIdByPageId` (messenger.service.js) para resolver a qué
 *     configuración pertenece un mensaje ENTRANTE → con 'revoked' los mensajes
 *     que escriben los clientes se DESCARTAN,
 *   - `getPageTokenByPageId`, remarketing_ms, conexionCanal.js,
 *   - `messenger_conectado` del dashboard y ~9 consultas de
 *     configuraciones.controller.
 *
 * Se probó marcarlas el 2026-08-27 y la página de JNstore (cfg 285), que sí
 * recibía mensajes, dejó de enrutarlos. Un token muerto solo rompe el ENVÍO;
 * degradar también la RECEPCIÓN deja al negocio sin ver lo que le escriben,
 * que es peor que el problema original.
 *
 * La señal correcta es `token_valido`: es la que lee el banner del front y no
 * altera ningún flujo existente.
 */
async function guardarDiagnostico(d, { marcarRevoked = false } = {}) {
  const scopes = (d.scopes || []).join(',') || null;

  await db.query(
    `UPDATE messenger_pages
        SET token_valido      = ?,
            token_revisado_at = NOW(),
            token_error       = ?,
            token_scopes      = ?,
            puede_leer_feed   = ?,
            updated_at        = NOW()
      WHERE id_messenger_page = ?`,
    {
      replacements: [
        d.token_valido === null ? null : d.token_valido ? 1 : 0,
        d.token_error ? String(d.token_error).slice(0, 255) : null,
        scopes,
        d.puede_leer_feed === null ? null : d.puede_leer_feed ? 1 : 0,
        d.id_messenger_page,
      ],
    },
  );

  // Marcar revocada: solo con un veredicto claro de Meta.
  if (marcarRevoked && d.concluyente && d.token_valido === false) {
    await db.query(
      `UPDATE messenger_pages
          SET status = 'revoked', revoked_at = NOW(), updated_at = NOW()
        WHERE id_messenger_page = ? AND status = 'active'`,
      { replacements: [d.id_messenger_page] },
    );
  }

  // Si revivió (el cliente reconectó), devolverla a activa.
  if (d.concluyente && d.token_valido === true) {
    await db.query(
      `UPDATE messenger_pages
          SET status = 'active', revoked_at = NULL, updated_at = NOW()
        WHERE id_messenger_page = ? AND status = 'revoked'`,
      { replacements: [d.id_messenger_page] },
    );
  }
}

/**
 * Revisa las páginas y devuelve el resumen.
 *
 * @param {number|null} id_configuracion  limitar a una conexión (null = todas)
 * @param {boolean} persistir             escribir el resultado en BD
 * @param {boolean} marcarRevoked         permitir cambiar status a 'revoked'
 */
async function revisarPaginas({
  id_configuracion = null,
  persistir = true,
  marcarRevoked = false, // ver la advertencia en guardarDiagnostico()
  incluirRevocadas = true,
} = {}) {
  const filtros = [];
  const params = [];

  if (id_configuracion) {
    filtros.push('id_configuracion = ?');
    params.push(id_configuracion);
  }
  if (!incluirRevocadas) {
    filtros.push("status = 'active'");
  }

  const where = filtros.length ? `WHERE ${filtros.join(' AND ')}` : '';

  const paginas = await db.query(
    `SELECT id_messenger_page, id_configuracion, page_id, page_name,
            page_access_token, status, connected_at
       FROM messenger_pages
       ${where}
      ORDER BY connected_at DESC`,
    { replacements: params, type: db.QueryTypes.SELECT },
  );

  const resultados = [];

  // Secuencial a propósito: son pocas páginas y así no se dispara el rate
  // limit de Graph ni se producen timeouts que arruinen el diagnóstico.
  for (const p of paginas) {
    const d = await revisarPagina(p);
    if (persistir) {
      await guardarDiagnostico(d, { marcarRevoked }).catch((e) => {
        console.error('[MS][HEALTH][GUARDAR]', p.page_id, e.message);
      });
    }
    resultados.push(d);
  }

  const resumen = {
    total: resultados.length,
    sanas: resultados.filter((r) => r.token_valido === true).length,
    muertas: resultados.filter((r) => r.token_valido === false).length,
    indeterminadas: resultados.filter((r) => r.token_valido === null).length,
    pueden_leer_feed: resultados.filter((r) => r.puede_leer_feed === true)
      .length,
    con_manage_engagement: resultados.filter((r) =>
      (r.scopes || []).includes('pages_manage_engagement'),
    ).length,
  };

  return { resumen, resultados };
}

/**
 * Lee el último diagnóstico guardado, sin tocar Graph.
 */
async function leerDiagnosticoGuardado(id_configuracion) {
  return db.query(
    `SELECT id_messenger_page, id_configuracion, page_id, page_name,
            page_access_token, status, token_valido, token_revisado_at,
            token_error, token_scopes, puede_leer_feed
       FROM messenger_pages
      WHERE id_configuracion = ?
      ORDER BY connected_at DESC`,
    { replacements: [id_configuracion], type: db.QueryTypes.SELECT },
  );
}

/** Horas que se considera fresco un diagnóstico antes de volver a preguntar. */
const TTL_HORAS = 6;

/**
 * Salud con caché: sirve lo guardado y solo consulta a Meta lo que está viejo.
 *
 * Existe por el rate limit. `debug_token` se autentica con el APP TOKEN, así
 * que consume el cupo horario de TODA la app (`X-App-Usage`), el mismo que usan
 * WhatsApp, Meta Ads y los perfiles de página. Medido el 2026-08-27 ese balde ya
 * estaba al 25% con el tráfico normal. Llamar a Graph en cada render de la
 * pestaña de conexiones gastaba cupo compartido para recalcular algo que cambia
 * como mucho una vez al día, y el cron ya lo refresca de madrugada.
 *
 * Leer el feed usa el token de PÁGINA y va contra un cupo aparte por página
 * (`X-Business-Use-Case`), mucho más holgado — pero igual se cachea.
 */
async function saludConCache({
  id_configuracion,
  forzar = false,
  ttlHoras = TTL_HORAS,
}) {
  const filas = await leerDiagnosticoGuardado(id_configuracion);

  const limite = Date.now() - ttlHoras * 60 * 60 * 1000;
  const estaVieja = (f) =>
    !f.token_revisado_at || new Date(f.token_revisado_at).getTime() < limite;

  const aRevisar = forzar ? filas : filas.filter(estaVieja);

  let refrescadas = 0;
  for (const f of aRevisar) {
    const d = await revisarPagina(f);
    // Sin marcarRevoked: este endpoint lo llama el front y nunca debe cambiar
    // el enrutamiento de mensajes entrantes.
    await guardarDiagnostico(d).catch((e) => {
      console.error('[MS][HEALTH][CACHE][GUARDAR]', f.page_id, e.message);
    });
    refrescadas++;
  }

  // Se relee para devolver siempre el estado ya persistido.
  const finales = refrescadas ? await leerDiagnosticoGuardado(id_configuracion) : filas;

  return {
    desde_cache: refrescadas === 0,
    refrescadas,
    total: finales.length,
    data: finales.map((f) => {
      const scopes = (f.token_scopes || '').split(',').filter(Boolean);
      return {
        page_id: f.page_id,
        page_name: f.page_name,
        status: f.status,
        // null = nunca revisada o chequeo no concluyente. El front NO debe
        // tratarlo como caída ni pedir reconexión por eso.
        token_valido:
          f.token_valido === null ? null : Number(f.token_valido) === 1,
        token_error: f.token_error,
        token_revisado_at: f.token_revisado_at,
        puede_leer_feed:
          f.puede_leer_feed === null ? null : Number(f.puede_leer_feed) === 1,
        tiene_manage_engagement: scopes.includes('pages_manage_engagement'),
        tiene_read_engagement: scopes.includes('pages_read_engagement'),
        requiere_reconexion: Number(f.token_valido) === 0,
      };
    }),
  };
}

module.exports = {
  revisarPaginas,
  revisarPagina,
  inspeccionarToken,
  puedeLeerFeed,
  guardarDiagnostico,
  leerDiagnosticoGuardado,
  saludConCache,
  TTL_HORAS,
};
