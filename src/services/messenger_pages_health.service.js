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
const { db } = require('../database/config');

const GRAPH_VERSION = process.env.GRAPH_VERSION || 'v22.0';
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_VERSION}`;
const { resolveApp, appSecretProof } = require('../config/metaApps');

// Tanto el token de app como el proof dependen de qué app emitió el token de
// la página. Con dos apps ya no hay un par id|secreto único: se resuelve desde
// messenger_pages.fb_app_id (NULL -> app legacy).
const APP_TOKEN = (fbAppId) => resolveApp(fbAppId).appAccessToken;

function appsecretProof(accessToken, fbAppId) {
  return appSecretProof(accessToken, resolveApp(fbAppId));
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
async function inspeccionarToken(token, { intentos = 3, fbAppId = null } = {}) {
  let ultimoError = null;

  for (let i = 0; i < intentos; i++) {
    try {
      const r = await axios.get(`${GRAPH_BASE}/debug_token`, {
        params: { input_token: token, access_token: APP_TOKEN(fbAppId) },
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
async function puedeLeerFeed(pageId, token, fbAppId = null) {
  try {
    const proof = appsecretProof(token, fbAppId);
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

  const info = await inspeccionarToken(pagina.page_access_token, {
    fbAppId: pagina.fb_app_id,
  });

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

  const feed = await puedeLeerFeed(
    pagina.page_id,
    pagina.page_access_token,
    pagina.fb_app_id,
  );

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
            page_access_token, fb_app_id, status, connected_at
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

/* ═══════════════════════════════════════════════════════════════════════
   Instagram + aviso de reconexión del inbox (10-11-2026)

   Caso JNstore (cfg 285): 234 mensajes de Messenger sin una sola respuesta
   desde julio. El token de la página murió (190/492: quien la conectó dejó
   de ser administrador) y la única señal era un banner dentro de la pestaña
   Messenger de /canal-conexiones, que el dueño nunca abrió. Instagram ni
   siquiera se revisaba: instagram_pages guarda SU propio token de página y
   no tenía columnas de salud. Ese mismo día había otra cuenta con Instagram
   muerto (190/464) sin que nadie lo supiera.

   Acá se revisa Instagram y se arma, para Messenger e Instagram, el dato
   que leen la tarjeta de /conexiones y el aviso al entrar.
   ═══════════════════════════════════════════════════════════════════════ */

/* Columnas de salud en instagram_pages. Se agregan solas la primera vez
   (tabla de decenas de filas). Si el ALTER falla no se rompe nada: Instagram
   simplemente sigue sin aviso. */
let columnasIg = null;
function ensureColumnasInstagram() {
  if (columnasIg) return columnasIg;
  columnasIg = (async () => {
    const cols = await db.query(
      `SHOW COLUMNS FROM instagram_pages LIKE 'token\\_%'`,
      { type: db.QueryTypes.SELECT },
    );
    const hay = new Set(cols.map((c) => c.Field));
    const faltan = [
      ['token_valido', 'TINYINT(1) NULL DEFAULT NULL'],
      ['token_revisado_at', 'DATETIME NULL DEFAULT NULL'],
      ['token_error', 'VARCHAR(255) NULL DEFAULT NULL'],
    ].filter(([nombre]) => !hay.has(nombre));
    if (faltan.length) {
      await db.query(
        `ALTER TABLE instagram_pages ${faltan
          .map(([nombre, tipo]) => `ADD COLUMN ${nombre} ${tipo}`)
          .join(', ')}`,
      );
    }
    return true;
  })().catch((e) => {
    console.error('[IG][HEALTH][COLUMNAS]', e.message);
    columnasIg = null; // se reintenta en la próxima llamada
    return false;
  });
  return columnasIg;
}

/**
 * ¿Sigue vivo este token de página? Se pregunta con el propio token
 * (`GET /me`), no con debug_token: instagram_pages no guarda qué app lo
 * emitió, y así el gasto va al cupo de la página y no al de toda la app.
 * Probado el 10-11-2026 contra las 11 conexiones activas: 9 respondieron 200
 * y 2 el error 190 (subcódigos 492 y 464).
 *
 * Igual que inspeccionarToken: solo un 190/102 explícito de Meta cuenta como
 * "muerto"; un timeout o un 500 es "no pude preguntar" y no cambia nada.
 */
async function tokenVivoPorMe(token, { intentos = 2, timeout = 15000 } = {}) {
  let ultimoError = null;
  for (let i = 0; i < intentos; i++) {
    try {
      const r = await axios.get(`${GRAPH_BASE}/me`, {
        params: { fields: 'id', access_token: token },
        validateStatus: () => true,
        timeout,
      });
      if (r.status === 200 && r.data?.id) {
        return { concluyente: true, valido: true, error: null };
      }
      const err = r.data?.error;
      if (err && CODIGOS_TOKEN_MUERTO.has(Number(err.code))) {
        return {
          concluyente: true,
          valido: false,
          error: err.message || 'Token inválido',
        };
      }
      ultimoError = err?.message || `HTTP ${r.status}`;
    } catch (e) {
      ultimoError = e.message;
    }
    if (i < intentos - 1) await new Promise((r) => setTimeout(r, 1000));
  }
  return { concluyente: false, valido: null, error: ultimoError };
}

/**
 * Revisa las conexiones activas de Instagram. Solo se guarda un veredicto
 * concluyente: si Meta no contestó, la fila queda como estaba (un fallo de
 * red no debe ni encender ni apagar el aviso).
 */
async function revisarInstagram({
  id_configuracion = null, // un id o una lista de ids
  persistir = true,
  // Solo las que nunca se revisaron: lo usa el listado de /conexiones para
  // no esperar al cron de la madrugada con una conexión recién creada (o con
  // las que ya existían cuando se agregaron las columnas). Una llamada rápida
  // por conexión, una sola vez.
  soloSinRevisar = false,
} = {}) {
  const listas = await ensureColumnasInstagram();
  if (soloSinRevisar && !listas) return { resumen: {}, resultados: [] };
  const ids = [].concat(id_configuracion || []).map(Number).filter(Boolean);
  const filas = await db.query(
    `SELECT id_instagram_page, id_configuracion, page_id, page_name,
            ig_username, page_access_token
       FROM instagram_pages
      WHERE status = 'active'
        ${ids.length ? 'AND id_configuracion IN (?)' : ''}
        ${soloSinRevisar ? 'AND token_revisado_at IS NULL' : ''}`,
    {
      replacements: ids.length ? [ids] : [],
      type: db.QueryTypes.SELECT,
    },
  );

  const resultados = [];
  for (const f of filas) {
    const d = f.page_access_token
      ? await tokenVivoPorMe(
          f.page_access_token,
          soloSinRevisar ? { intentos: 1, timeout: 6000 } : {},
        )
      : {
          concluyente: true,
          valido: false,
          error: 'La conexión no tiene page_access_token guardado',
        };

    if (persistir && listas && d.concluyente) {
      await db
        .query(
          `UPDATE instagram_pages
              SET token_valido = ?, token_revisado_at = NOW(), token_error = ?
            WHERE id_instagram_page = ?`,
          {
            replacements: [
              d.valido ? 1 : 0,
              d.error ? String(d.error).slice(0, 255) : null,
              f.id_instagram_page,
            ],
            type: db.QueryTypes.UPDATE,
          },
        )
        .catch((e) => {
          console.error('[IG][HEALTH][GUARDAR]', f.page_id, e.message);
        });
    }

    resultados.push({
      id_configuracion: f.id_configuracion,
      page_id: f.page_id,
      page_name: f.page_name,
      ig_username: f.ig_username,
      token_valido: d.concluyente ? d.valido : null,
      token_error: d.error,
    });
  }

  return {
    resumen: {
      total: resultados.length,
      sanas: resultados.filter((r) => r.token_valido === true).length,
      muertas: resultados.filter((r) => r.token_valido === false).length,
      indeterminadas: resultados.filter((r) => r.token_valido === null).length,
    },
    resultados,
  };
}

/**
 * Tras reconectar, el veredicto viejo ya no vale (el token es nuevo): se
 * borra para que el aviso desaparezca en el acto. El cron lo vuelve a medir.
 */
async function limpiarSaludTrasReconectar({ canal, id_configuracion, page_id }) {
  try {
    if (canal === 'ig' && !(await ensureColumnasInstagram())) return;
    const tabla = canal === 'ig' ? 'instagram_pages' : 'messenger_pages';
    await db.query(
      `UPDATE ${tabla}
          SET token_valido = NULL, token_error = NULL, token_revisado_at = NULL
        WHERE id_configuracion = ? AND page_id = ?`,
      { replacements: [id_configuracion, page_id], type: db.QueryTypes.UPDATE },
    );
  } catch (e) {
    console.error('[INBOX][HEALTH][LIMPIAR]', canal, page_id, e.message);
  }
}

/**
 * El motivo en palabras del dueño de la cuenta. El texto de Meta viene en
 * inglés y habla de "impersonate": no le dice a nadie qué hacer.
 */
function motivoReconexion(tokenError) {
  const t = String(tokenError || '').toLowerCase();
  // Frases cortas, en minúscula y sin punto: el front las pega tras
  // "Vuelve a conectar X: …". Una sola idea, sin explicar a Meta.
  if (/administrator|moderator|impersonate/.test(t)) {
    return 'quien conectó la página ya no es su administrador';
  }
  if (/password|session has been invalidated|logged out/.test(t)) {
    return 'quien conectó la página cambió su contraseña de Facebook';
  }
  if (/has not authorized|not authorized application|deauthorized/.test(t)) {
    return 'se quitó el permiso de ImporChat en Facebook';
  }
  if (/expired/.test(t)) {
    return 'el permiso de Facebook caducó';
  }
  return 'Facebook retiró el acceso a la página';
}

/**
 * Qué inbox de cada conexión necesita reconectarse.
 * Devuelve Map<id_configuracion, { ms, ig }>; cada canal es null (sin
 * problema conocido) o { pagina, motivo, revisado_at }.
 *
 * Solo `token_valido = 0`, que es un veredicto explícito de Meta. NULL
 * (nunca revisada o chequeo no concluyente) no avisa. Nunca lanza: si algo
 * falla, la tarjeta se queda sin aviso en vez de romper el listado.
 */
async function saludInbox(ids) {
  const out = new Map();
  const lista = [...new Set((ids || []).map(Number).filter(Boolean))];
  if (!lista.length) return out;
  const de = (id) => {
    const k = Number(id);
    if (!out.has(k)) out.set(k, { ms: null, ig: null });
    return out.get(k);
  };

  try {
    const filas = await db.query(
      `SELECT id_configuracion, page_name, token_error, token_revisado_at
         FROM messenger_pages
        WHERE id_configuracion IN (?)
          AND status = 'active' AND subscribed = 1 AND token_valido = 0`,
      { replacements: [lista], type: db.QueryTypes.SELECT },
    );
    for (const f of filas) {
      de(f.id_configuracion).ms = {
        pagina: f.page_name || null,
        motivo: motivoReconexion(f.token_error),
        revisado_at: f.token_revisado_at,
      };
    }
  } catch (e) {
    console.error('[INBOX][HEALTH][MS]', e.message);
  }

  try {
    if (await ensureColumnasInstagram()) {
      // Las que nunca se revisaron se revisan ahora (ver revisarInstagram).
      await revisarInstagram({
        id_configuracion: lista,
        soloSinRevisar: true,
      }).catch((e) => console.error('[INBOX][HEALTH][IG][LAZY]', e.message));
      const filas = await db.query(
        `SELECT id_configuracion, page_name, ig_username, token_error,
                token_revisado_at
           FROM instagram_pages
          WHERE id_configuracion IN (?)
            AND status = 'active' AND subscribed = 1 AND token_valido = 0`,
        { replacements: [lista], type: db.QueryTypes.SELECT },
      );
      for (const f of filas) {
        de(f.id_configuracion).ig = {
          pagina: f.ig_username ? `@${f.ig_username}` : f.page_name || null,
          motivo: motivoReconexion(f.token_error),
          revisado_at: f.token_revisado_at,
        };
      }
    }
  } catch (e) {
    console.error('[INBOX][HEALTH][IG]', e.message);
  }

  return out;
}

/** Agrega al listado de /conexiones los campos del aviso de reconexión. */
async function anexarSaludInbox(rows) {
  const salud = await saludInbox((rows || []).map((r) => r.id));
  for (const r of rows || []) {
    const s = salud.get(Number(r.id)) || { ms: null, ig: null };
    r.messenger_requiere_reconexion = s.ms ? 1 : 0;
    r.messenger_motivo_reconexion = s.ms?.motivo || null;
    r.instagram_requiere_reconexion = s.ig ? 1 : 0;
    r.instagram_motivo_reconexion = s.ig?.motivo || null;
  }
  return rows;
}

/**
 * Cuánta gente escribió por los canales caídos en los últimos 30 días: es
 * lo que hace que el aviso se entienda ("X personas te escribieron y no
 * recibieron respuesta") en vez de sonar a detalle técnico.
 */
async function personasEsperando(id_configuracion, canales) {
  if (!canales.length) return 0;
  try {
    const [fila] = await db.query(
      `SELECT COUNT(DISTINCT celular_recibe) AS n
         FROM mensajes_clientes
        WHERE id_configuracion = ?
          AND source IN (?)
          AND rol_mensaje = 0
          AND created_at >= NOW() - INTERVAL 30 DAY`,
      { replacements: [id_configuracion, canales], type: db.QueryTypes.SELECT },
    );
    return Number(fila?.n || 0);
  } catch (e) {
    console.error('[INBOX][HEALTH][ESPERANDO]', e.message);
    return 0;
  }
}

module.exports = {
  revisarInstagram,
  tokenVivoPorMe,
  limpiarSaludTrasReconectar,
  motivoReconexion,
  saludInbox,
  anexarSaludInbox,
  personasEsperando,
  revisarPaginas,
  revisarPagina,
  inspeccionarToken,
  puedeLeerFeed,
  guardarDiagnostico,
  leerDiagnosticoGuardado,
  saludConCache,
  TTL_HORAS,
};
