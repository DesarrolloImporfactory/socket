/**
 * Ingesta de comentarios de publicaciones de Facebook (webhook `feed`).
 *
 * Ingesta (webhook) y lectura (bandeja). Publicar respuestas y el puente
 * "responder en privado" van en una fase siguiente.
 *
 * Los comentarios viven en `facebook_posts` / `facebook_comments`, tablas
 * propias, y deliberadamente NO en `mensajes_clientes`. El motivo: el `source`
 * de esa tabla es enum('wa','ms','ig') y toda la maquinaria que cuelga de ella
 * asume una conversación 1-a-1 — vista_chats, la ventana de 24h, el round-robin
 * de encargados, el kanban con IA y, sobre todo, el remarketing. Un comentario
 * es público y es un árbol (post → comentario → respuesta), no tiene ventana de
 * 24h, y meterlo ahí haría que a cada persona que comenta un post se le
 * empiecen a mandar campañas de remarketing.
 *
 * Para que llegue algo hacen falta DOS suscripciones al campo `feed`, y si
 * falta cualquiera de las dos no hay error en ningún lado, simplemente no pasa
 * nada:
 *   1. A nivel de app:     App Dashboard > Webhooks > Page > marcar 'feed'
 *   2. A nivel de página:  scripts/suscribirFeedPaginas.js --aplicar
 * El estado de la cadena completa se revisa con scripts/diagnosticoComentarios.js
 *
 * Nada de lo que hay acá debe lanzar hacia el webhook: si esto revienta, Meta
 * reintenta el evento completo y se reprocesarían también los mensajes de
 * Messenger que venían en el mismo entry.
 */

const { db } = require('../database/config');
const { getConfigIdByPageId } = require('./messenger.service');

// Verbos que Meta manda en value.verb para item='comment'.
const VERBOS_CONOCIDOS = new Set(['add', 'edited', 'remove', 'hide', 'unhide']);

const aFecha = (unixSegundos) =>
  unixSegundos ? new Date(Number(unixSegundos) * 1000) : new Date();

/**
 * Crea la publicación si es la primera vez que la vemos.
 *
 * Los posts no se sincronizan por adelantado: se descubren cuando llega el
 * primer comentario. El texto y el permalink quedan en NULL hasta que la Fase 2
 * los pida a Graph, por eso acá sólo se guardan los ids.
 */
async function asegurarPost({ id_configuracion, page_id, post_id, fecha }) {
  await db.query(
    `INSERT INTO facebook_posts
       (id_configuracion, page_id, post_id, ultimo_comentario_at)
     VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       ultimo_comentario_at = GREATEST(
         COALESCE(ultimo_comentario_at, '1970-01-01'), VALUES(ultimo_comentario_at)
       )`,
    {
      replacements: [id_configuracion, page_id, post_id, fecha],
      type: db.QueryTypes.INSERT,
    },
  );

  const [row] = await db.query(
    `SELECT id_facebook_post FROM facebook_posts
      WHERE id_configuracion = ? AND post_id = ? LIMIT 1`,
    {
      replacements: [id_configuracion, post_id],
      type: db.QueryTypes.SELECT,
    },
  );
  return row?.id_facebook_post || null;
}

/**
 * Recalcula los contadores del post leyendo los comentarios.
 *
 * Se recalcula en vez de sumar/restar porque los verbos llegan desordenados y
 * se repiten (Meta reintenta): un contador incremental se desincroniza y no hay
 * forma de saber que pasó. Son dos COUNT() sobre un índice, y el volumen de
 * comentarios por post es de decenas, no de miles.
 */
async function recalcularContadores(id_facebook_post) {
  await db.query(
    `UPDATE facebook_posts p
        SET p.total_comentarios = (
              SELECT COUNT(*) FROM facebook_comments c
               WHERE c.id_facebook_post = p.id_facebook_post
                 AND c.eliminado_at IS NULL
            ),
            p.sin_responder = (
              SELECT COUNT(*) FROM facebook_comments c
               WHERE c.id_facebook_post = p.id_facebook_post
                 AND c.eliminado_at IS NULL
                 AND c.es_de_la_pagina = 0
                 AND c.respondido = 0
            )
      WHERE p.id_facebook_post = ?`,
    { replacements: [id_facebook_post], type: db.QueryTypes.UPDATE },
  );
}

async function guardarComentario({ id_configuracion, page_id, valor }) {
  const post_id = valor.post_id;
  if (!post_id) {
    console.warn(
      '[FB_FEED] comentario sin post_id, se ignora',
      valor.comment_id,
    );
    return null;
  }

  const comentado_at = aFecha(valor.created_time);
  const id_facebook_post = await asegurarPost({
    id_configuracion,
    page_id,
    post_id,
    fecha: comentado_at,
  });
  if (!id_facebook_post) return null;

  // Meta manda parent_id = post_id cuando el comentario es de primer nivel.
  const parent =
    valor.parent_id && valor.parent_id !== post_id ? valor.parent_id : null;

  // `from` sólo viene si el token tiene pages_read_engagement. Sin él no se
  // puede distinguir al autor y todo comentario parecerá de un tercero.
  const from_id = valor.from?.id ? String(valor.from.id) : null;
  const es_de_la_pagina = from_id && from_id === String(page_id) ? 1 : 0;

  const media = valor.photo || valor.video || valor.link || null;

  // Ojo: el UPDATE no toca `respondido` ni las columnas de privado. Un
  // verb='edited' es el usuario corrigiendo su texto, no un comentario nuevo:
  // si se reseteara, un comentario ya atendido volvería a la bandeja.
  await db.query(
    `INSERT INTO facebook_comments
       (id_configuracion, id_facebook_post, page_id, post_id, comment_id,
        parent_comment_id, from_id, from_nombre, mensaje, media_url,
        permalink_url, es_de_la_pagina, comentado_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       mensaje       = VALUES(mensaje),
       media_url     = VALUES(media_url),
       permalink_url = COALESCE(VALUES(permalink_url), permalink_url),
       from_nombre   = COALESCE(VALUES(from_nombre), from_nombre),
       eliminado_at  = NULL,
       updated_at    = NOW()`,
    {
      replacements: [
        id_configuracion,
        id_facebook_post,
        page_id,
        post_id,
        valor.comment_id,
        parent,
        from_id,
        valor.from?.name || null,
        valor.message || null,
        media,
        valor.permalink_url || null,
        es_de_la_pagina,
        comentado_at,
      ],
      type: db.QueryTypes.INSERT,
    },
  );

  // Si respondió la propia página —desde acá o desde Facebook— el comentario
  // padre queda atendido. Esto es lo que hace que la bandeja no muestre como
  // pendiente algo que el cliente ya contestó por su cuenta.
  if (es_de_la_pagina && parent) {
    await db.query(
      `UPDATE facebook_comments
          SET respondido = 1,
              respondido_at = COALESCE(respondido_at, ?),
              respuesta_comment_id = COALESCE(respuesta_comment_id, ?)
        WHERE id_configuracion = ? AND comment_id = ?`,
      {
        replacements: [comentado_at, valor.comment_id, id_configuracion, parent],
        type: db.QueryTypes.UPDATE,
      },
    );
  }

  await recalcularContadores(id_facebook_post);

  console.log(
    `[FB_FEED] ✅ guardado comment_id=${valor.comment_id} ` +
      `post=${id_facebook_post} ` +
      `${es_de_la_pagina ? '(respuesta de la página)' : `de "${valor.from?.name || 'desconocido'}"`}` +
      `${parent ? ` → responde a ${parent}` : ''}`,
  );

  return { id_facebook_post, es_de_la_pagina, parent };
}

async function marcarEliminado({ id_configuracion, comment_id }) {
  const [row] = await db.query(
    `SELECT id_facebook_post FROM facebook_comments
      WHERE id_configuracion = ? AND comment_id = ? LIMIT 1`,
    { replacements: [id_configuracion, comment_id], type: db.QueryTypes.SELECT },
  );
  if (!row) return null;

  // Borrado lógico: Meta no reenvía el contenido de un comentario borrado, así
  // que con un DELETE se perdería el historial de lo que se respondió.
  await db.query(
    `UPDATE facebook_comments SET eliminado_at = NOW()
      WHERE id_configuracion = ? AND comment_id = ? AND eliminado_at IS NULL`,
    { replacements: [id_configuracion, comment_id], type: db.QueryTypes.UPDATE },
  );
  await recalcularContadores(row.id_facebook_post);
  return row.id_facebook_post;
}

async function marcarOculto({ id_configuracion, comment_id, oculto }) {
  await db.query(
    `UPDATE facebook_comments SET oculto = ?
      WHERE id_configuracion = ? AND comment_id = ?`,
    {
      replacements: [oculto ? 1 : 0, id_configuracion, comment_id],
      type: db.QueryTypes.UPDATE,
    },
  );
}

/**
 * Punto de entrada desde el webhook: un elemento de entry.changes[].
 */
async function procesarCambioFeed(page_id, change) {
  if (change?.field !== 'feed') {
    console.log('[FB_FEED] ignorado: field =', change?.field);
    return;
  }

  const valor = change.value || {};

  // El campo `feed` también notifica posts, reacciones, likes y shares. En v1
  // sólo interesan los comentarios.
  if (valor.item !== 'comment') {
    console.log('[FB_FEED] ignorado: item =', valor.item, '(v1 sólo comentarios)');
    return;
  }
  if (!valor.comment_id) {
    console.log('[FB_FEED] ignorado: comentario sin comment_id');
    return;
  }

  const verb = valor.verb;
  if (!VERBOS_CONOCIDOS.has(verb)) {
    console.log('[FB_FEED] verbo desconocido, se ignora:', verb);
    return;
  }

  const id_configuracion = await getConfigIdByPageId(page_id);
  if (!id_configuracion) {
    // Página no conectada, suspendida, o marcada revoked. Mismo criterio que
    // usa Messenger para los mensajes entrantes.
    console.log('[FB_FEED] sin configuración para page_id=', page_id);
    return;
  }

  // En una sola línea a propósito: console.log de un objeto lo imprime en
  // varias, y al filtrar los logs con grep sólo sobrevive la primera — que es
  // justo la que no lleva datos.
  console.log(
    '[FB_FEED] ' +
      JSON.stringify({
        page_id,
        id_configuracion,
        verb,
        comment_id: valor.comment_id,
        post_id: valor.post_id,
        from: valor.from?.id || '(sin from: falta pages_read_engagement)',
      }),
  );

  switch (verb) {
    case 'add':
    case 'edited':
      return guardarComentario({ id_configuracion, page_id, valor });
    case 'remove':
      return marcarEliminado({ id_configuracion, comment_id: valor.comment_id });
    case 'hide':
    case 'unhide':
      return marcarOculto({
        id_configuracion,
        comment_id: valor.comment_id,
        oculto: verb === 'hide',
      });
  }
}

/* ------------------------------------------------------------------ *
 * Lectura (bandeja de comentarios)
 * ------------------------------------------------------------------ */

const LIMITE_POR_DEFECTO = 20;
const LIMITE_MAXIMO = 100;

function normalizarPaginacion({ pagina, limite }) {
  const p = Math.max(1, Number.parseInt(pagina, 10) || 1);
  const l = Math.min(
    LIMITE_MAXIMO,
    Math.max(1, Number.parseInt(limite, 10) || LIMITE_POR_DEFECTO),
  );
  return { pagina: p, limite: l, offset: (p - 1) * l };
}

// Tope por petición y frescura del detalle. La cuota de Graph es de TODA la
// app y la comparte WhatsApp, así que abrir la bandeja no puede convertirse en
// una ráfaga de llamadas: se refrescan unas pocas por vez y el resto cae en la
// siguiente apertura.
const TOPE_REFRESCO_POSTS = 8;
const HORAS_FRESCURA_POSTS = 24;

/**
 * Rellena el detalle de las publicaciones que aún no lo tienen.
 *
 * Los posts se descubren por el webhook `feed`, que sólo trae ids: el texto,
 * la foto, el permalink y la fecha de publicación hay que pedírselos a Graph.
 * Esto es la "Fase 2" que menciona asegurarPost().
 *
 * Se hace acá —perezosamente, al abrir la bandeja— y NO en la ingesta, porque
 * el webhook no debe hacer llamadas de red: si una falla, Meta reintenta el
 * entry completo y se reprocesarían también los mensajes de Messenger que
 * venían en el mismo lote.
 *
 * Un fallo por publicación no rompe la bandeja: se marca el intento igual, para
 * no reintentar en cada apertura una publicación que el negocio ya borró de
 * Facebook.
 */
async function refrescarDetallePosts({ id_configuracion, posts }) {
  const pendientes = (posts || [])
    .filter((p) => {
      if (!p.detalle_refrescado_at) return true;
      const horas =
        (Date.now() - new Date(p.detalle_refrescado_at).getTime()) / 36e5;
      return horas >= HORAS_FRESCURA_POSTS;
    })
    .slice(0, TOPE_REFRESCO_POSTS);

  if (!pendientes.length) return posts;

  // Un token por página, no uno por publicación.
  const filas = await db.query(
    `SELECT page_id, page_access_token, fb_app_id
       FROM messenger_pages
      WHERE id_configuracion = ? AND status = 'active'`,
    { replacements: [id_configuracion], type: db.QueryTypes.SELECT },
  );
  const paginas = new Map(filas.map((f) => [String(f.page_id), f]));

  await Promise.allSettled(
    pendientes.map(async (post) => {
      const pagina = paginas.get(String(post.page_id));
      if (!pagina?.page_access_token) return;

      try {
        const proof = appsecretProof(
          pagina.page_access_token,
          pagina.fb_app_id,
        );
        const { data } = await axios.get(
          `${GRAPH_BASE}/${encodeURIComponent(post.post_id)}`,
          {
            params: {
              // `story` cubre las publicaciones sin texto propio ("X actualizó
              // su foto de portada"), que si no salen en blanco en la bandeja.
              fields:
                'message,story,permalink_url,created_time,full_picture,attachments{media_type}',
              access_token: pagina.page_access_token,
              ...(proof ? { appsecret_proof: proof } : {}),
            },
            timeout: 8000,
          },
        );

        const detalle = {
          mensaje: data.message || data.story || '',
          media_url: data.full_picture || null,
          permalink_url: data.permalink_url || null,
          publicado_at: data.created_time ? new Date(data.created_time) : null,
          tipo: data.attachments?.data?.[0]?.media_type || null,
        };

        await db.query(
          `UPDATE facebook_posts
              SET mensaje = ?, media_url = ?, permalink_url = ?,
                  publicado_at = ?, tipo = ?, detalle_refrescado_at = NOW()
            WHERE id_facebook_post = ?`,
          {
            replacements: [
              detalle.mensaje,
              detalle.media_url,
              detalle.permalink_url,
              detalle.publicado_at,
              detalle.tipo,
              post.id_facebook_post,
            ],
            type: db.QueryTypes.UPDATE,
          },
        );

        Object.assign(post, detalle);
      } catch (err) {
        console.warn(
          `[FB_COMENTARIOS] sin detalle del post ${post.post_id}: ` +
            describirErrorMeta(err),
        );
        await db.query(
          `UPDATE facebook_posts SET detalle_refrescado_at = NOW()
            WHERE id_facebook_post = ?`,
          {
            replacements: [post.id_facebook_post],
            type: db.QueryTypes.UPDATE,
          },
        );
      }
    }),
  );

  return posts;
}

/**
 * Publicaciones con actividad, la más reciente primero.
 *
 * Ordena por `ultimo_comentario_at` y no por fecha de publicación: lo que
 * importa en una bandeja es dónde está pasando algo ahora, no cuándo se
 * publicó. Con `solo_pendientes` quedan sólo las que tienen comentarios sin
 * responder. Ambos caminos usan el índice ix_fbp_bandeja.
 */
async function listarPosts({
  id_configuracion,
  pagina,
  limite,
  solo_pendientes = false,
}) {
  const pag = normalizarPaginacion({ pagina, limite });
  const filtro = solo_pendientes ? 'AND sin_responder > 0' : '';

  const posts = await db.query(
    `SELECT id_facebook_post, page_id, post_id, mensaje, tipo, media_url,
            permalink_url, publicado_at, total_comentarios, sin_responder,
            ultimo_comentario_at, detalle_refrescado_at
       FROM facebook_posts
      WHERE id_configuracion = ? ${filtro}
      ORDER BY ultimo_comentario_at DESC, id_facebook_post DESC
      LIMIT ? OFFSET ?`,
    {
      replacements: [id_configuracion, pag.limite, pag.offset],
      type: db.QueryTypes.SELECT,
    },
  );

  const [{ total }] = await db.query(
    `SELECT COUNT(*) AS total FROM facebook_posts
      WHERE id_configuracion = ? ${filtro}`,
    { replacements: [id_configuracion], type: db.QueryTypes.SELECT },
  );

  // Rellena texto, foto, permalink y fecha de las que todavía no los tienen.
  // Muta `posts` en sitio, así que lo de abajo ya sale completo.
  await refrescarDetallePosts({ id_configuracion, posts });

  return {
    posts,
    paginacion: {
      pagina: pag.pagina,
      limite: pag.limite,
      total: Number(total),
      total_paginas: Math.ceil(Number(total) / pag.limite) || 1,
    },
  };
}

/**
 * Hilo completo de una publicación, ya armado como árbol.
 *
 * El árbol se arma acá y no en el front porque la relación es por
 * `comment_id` (el id de Meta), no por la clave primaria, y dejar esa
 * traducción del lado del cliente obliga a repetirla en cada pantalla.
 *
 * Un comentario cuyo padre no está en la lista —porque se borró, o porque el
 * webhook del padre nunca llegó— se cuelga de la raíz en vez de descartarse:
 * en una bandeja es peor perder un comentario que mostrarlo fuera de sitio.
 */
async function listarComentarios({
  id_configuracion,
  id_facebook_post,
  incluir_ocultos = true,
}) {
  const filtro = incluir_ocultos ? '' : 'AND oculto = 0';

  const filas = await db.query(
    `SELECT id_facebook_comment, comment_id, parent_comment_id, from_id,
            from_nombre, mensaje, media_url, permalink_url, es_de_la_pagina,
            oculto, respondido, respondido_at, respuesta_comment_id,
            privado_enviado, privado_at, privado_error, id_cliente, comentado_at
       FROM facebook_comments
      WHERE id_configuracion = ?
        AND id_facebook_post = ?
        AND eliminado_at IS NULL ${filtro}
      ORDER BY comentado_at ASC, id_facebook_comment ASC`,
    {
      replacements: [id_configuracion, id_facebook_post],
      type: db.QueryTypes.SELECT,
    },
  );

  const porCommentId = new Map();
  for (const f of filas) porCommentId.set(f.comment_id, { ...f, respuestas: [] });

  const raiz = [];
  for (const nodo of porCommentId.values()) {
    const padre = nodo.parent_comment_id
      ? porCommentId.get(nodo.parent_comment_id)
      : null;
    if (padre) padre.respuestas.push(nodo);
    else raiz.push(nodo);
  }

  return { comentarios: raiz, total: filas.length };
}

/**
 * Contadores para el badge del menú. Dos COUNT sobre ix_fbp_bandeja.
 */
async function resumen({ id_configuracion }) {
  const [fila] = await db.query(
    `SELECT COUNT(*) AS posts_con_pendientes,
            COALESCE(SUM(sin_responder), 0) AS comentarios_pendientes
       FROM facebook_posts
      WHERE id_configuracion = ? AND sin_responder > 0`,
    { replacements: [id_configuracion], type: db.QueryTypes.SELECT },
  );
  return {
    posts_con_pendientes: Number(fila.posts_con_pendientes),
    comentarios_pendientes: Number(fila.comentarios_pendientes),
  };
}

/* ------------------------------------------------------------------ *
 * Escritura (responder)
 * ------------------------------------------------------------------ */

const axios = require('axios');

const GRAPH_VERSION = process.env.GRAPH_VERSION || 'v22.0';
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_VERSION}`;

const { resolveApp, appSecretProof } = require('../config/metaApps');

// El proof se firma con el secreto de la app que emitió el token de la página
// (messenger_pages.fb_app_id). Cruzarlos hace que Meta rechace la llamada.
const appsecretProof = (token, fbAppId) =>
  appSecretProof(token, resolveApp(fbAppId));

/**
 * Comentario + token de su página, ambos acotados a la configuración.
 *
 * El token se busca por (id_configuracion, page_id) y no sólo por page_id como
 * hace getPageTokenByPageId(): si la misma página estuviera en dos cuentas, esa
 * versión devuelve la primera que encuentre y se publicaría con las
 * credenciales equivocadas.
 */
async function cargarComentarioConToken({ id_configuracion, comment_id }) {
  const [fila] = await db.query(
    `SELECT c.id_facebook_comment, c.id_facebook_post, c.comment_id, c.page_id,
            c.post_id, c.es_de_la_pagina, c.eliminado_at, c.privado_enviado,
            c.parent_comment_id, c.comentado_at,
            p.page_access_token, p.fb_app_id, p.status AS page_status,
            p.page_name
       FROM facebook_comments c
       JOIN messenger_pages p
         ON p.page_id = c.page_id
        AND p.id_configuracion = c.id_configuracion
      WHERE c.id_configuracion = ? AND c.comment_id = ?
      LIMIT 1`,
    {
      replacements: [id_configuracion, comment_id],
      type: db.QueryTypes.SELECT,
    },
  );
  return fila || null;
}

// Traduce el error de Meta a algo accionable. `err.response.data.error` trae
// code/error_subcode/message; el message crudo es en inglés y muy técnico, y
// va directo a la bandeja: el agente lo lee y no sabe qué hacer con él.
//
// Sólo se traducen los casos que tienen una salida concreta. El resto conserva
// código y mensaje originales a propósito, porque es lo que sirve para buscar
// en la documentación de Meta cuando aparece algo nuevo.
function describirErrorMeta(err) {
  const m = err.response?.data?.error;
  if (!m) return err.message;

  // Cuando Meta manda `error_user_msg` ya viene redactado para el usuario final
  // y en su idioma. Es mejor que cualquier traducción nuestra, así que gana.
  if (m.error_user_msg) {
    return m.error_user_title
      ? `${m.error_user_title}: ${m.error_user_msg}`
      : m.error_user_msg;
  }

  // La firma se calcula con el secreto de la app que emitió el token
  // (messenger_pages.fb_app_id). Con dos apps conviviendo, este error significa
  // que la fila quedó apuntando a la app equivocada — normalmente una conexión
  // vieja — y se arregla reconectando la página.
  if (/appsecret_proof/i.test(m.message || '')) {
    return (
      'La firma de seguridad no coincide con la app que conectó esta página.' +
      ' Vuelve a conectarla en Canal de Conexiones.'
    );
  }

  // 190: token caducado o revocado. 200/10: falta un permiso.
  if (m.code === 190) {
    return (
      'La conexión con Facebook caducó. Vuelve a conectar la página en Canal' +
      ' de Conexiones.'
    );
  }

  const codigo = `${m.code}${m.error_subcode ? `/${m.error_subcode}` : ''}`;
  return `Meta ${codigo}: ${m.message}`;
}

/**
 * Publica una respuesta pública a un comentario.
 *
 * Marca el padre como respondido de una vez, sin esperar al webhook: Meta nos
 * va a notificar nuestra propia respuesta en unos segundos y `guardarComentario`
 * hará lo mismo, pero si la bandeja tarda ese rato en actualizarse el usuario
 * cree que no se envió y responde dos veces. La operación es idempotente
 * (COALESCE en respondido_at), así que que ocurra dos veces no hace daño.
 */
async function responder({ id_configuracion, comment_id, mensaje, id_sub_usuario }) {
  const texto = String(mensaje || '').trim();
  if (!texto) throw new Error('El mensaje no puede estar vacío');

  const c = await cargarComentarioConToken({ id_configuracion, comment_id });
  if (!c) throw new Error('El comentario no existe en esta cuenta');
  if (c.eliminado_at) throw new Error('El comentario fue eliminado en Facebook');
  if (!c.page_access_token || c.page_status !== 'active') {
    throw new Error(
      'La página no tiene una conexión activa. Vuelve a conectarla en Canal de Conexiones.',
    );
  }

  let respuesta_comment_id = null;
  try {
    const { data } = await axios.post(
      `${GRAPH_BASE}/${encodeURIComponent(c.comment_id)}/comments`,
      null,
      {
        params: {
          message: texto,
          access_token: c.page_access_token,
          appsecret_proof: appsecretProof(c.page_access_token, c.fb_app_id),
        },
        timeout: 20000,
      },
    );
    respuesta_comment_id = data?.id || null;
  } catch (err) {
    const detalle = describirErrorMeta(err);
    console.error(
      `[FB_COMENT][ERROR] responder cfg=${id_configuracion} ` +
        `comment=${comment_id} · ${detalle}`,
    );
    throw new Error(detalle);
  }

  await db.query(
    `UPDATE facebook_comments
        SET respondido = 1,
            respondido_at = COALESCE(respondido_at, NOW()),
            respondido_por = COALESCE(respondido_por, ?),
            respuesta_comment_id = COALESCE(respuesta_comment_id, ?)
      WHERE id_configuracion = ? AND comment_id = ?`,
    {
      replacements: [
        id_sub_usuario || null,
        respuesta_comment_id,
        id_configuracion,
        comment_id,
      ],
      type: db.QueryTypes.UPDATE,
    },
  );
  // La respuesta se guarda acá mismo, sin esperar al webhook.
  //
  // Meta nos devuelve nuestro propio comentario por el evento `feed`, pero eso
  // tarda —y si la suscripción se cae, no llega nunca—. Hasta entonces el
  // agente escribía, veía "enviado" y el hilo seguía igual, así que volvía a
  // responder pensando que no había salido. Insertándola ya, el recargarHilo()
  // del front la muestra al instante.
  //
  // Cuando el webhook llegue caerá en el ON DUPLICATE KEY de guardarComentario
  // —la única es (id_configuracion, comment_id)— y sólo refrescará el texto. No
  // se duplica.
  //
  // Va en su propio try y NO relanza: el comentario ya se publicó en Facebook.
  // Fallar acá haría que el agente viera un error de algo que sí funcionó, y
  // volvería a escribirlo.
  if (respuesta_comment_id) {
    try {
      await db.query(
        `INSERT INTO facebook_comments
           (id_configuracion, id_facebook_post, page_id, post_id, comment_id,
            parent_comment_id, from_id, from_nombre, mensaje,
            es_de_la_pagina, comentado_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, NOW())
         ON DUPLICATE KEY UPDATE
           mensaje    = VALUES(mensaje),
           updated_at = NOW()`,
        {
          replacements: [
            id_configuracion,
            c.id_facebook_post,
            c.page_id,
            c.post_id,
            respuesta_comment_id,
            c.comment_id,
            c.page_id, // el autor es la página
            c.page_name || null,
            texto,
          ],
          type: db.QueryTypes.INSERT,
        },
      );
    } catch (err) {
      console.error(
        `[FB_COMENT][WARN] respuesta publicada en Facebook pero no guardada ` +
          `localmente · cfg=${id_configuracion} · ${respuesta_comment_id} · ` +
          err.message,
      );
    }
  }

  await recalcularContadores(c.id_facebook_post);

  console.log(
    `[FB_COMENT] ✅ respondido comment=${comment_id} → ${respuesta_comment_id} ` +
      `· cfg=${id_configuracion}`,
  );

  return { respuesta_comment_id, id_facebook_post: c.id_facebook_post };
}

/**
 * Traduce los fallos típicos del mensaje privado.
 *
 * Meta devuelve el mismo 100/33 —"Object with ID ... does not exist, cannot be
 * loaded due to missing permissions, or does not support this operation"— para
 * causas completamente distintas, y en inglés. Volcado tal cual en la bandeja
 * no le dice nada al agente, que se queda reintentando.
 *
 * La causa más frecuente es la ventana de 7 días: pasado ese plazo desde que
 * se escribió el comentario, Facebook ya no acepta el privado.
 */
function describirErrorPrivado(err, { edadDias } = {}) {
  const m = err.response?.data?.error;
  if (!m) return err.message;

  // Meta ya replicó por este comentario. Pasa cuando alguien respondió desde
  // Facebook, o cuando el envío salió pero no llegamos a marcarlo en la fila.
  if (m.code === 10900) {
    return (
      'Ya se envió un mensaje privado por este comentario. Facebook solo' +
      ' permite uno.'
    );
  }

  // El comment_id ya no resuelve: casi siempre el comentario fue borrado.
  if (m.error_subcode === 1893060) {
    return (
      'El comentario ya no existe en Facebook, así que no se le puede' +
      ' responder en privado.'
    );
  }

  // Fuera de la ventana de 7 días. No hay un código propio, así que se apoya
  // en la edad del comentario, que es la única señal fiable que tenemos.
  if (typeof edadDias === 'number' && edadDias > 7) {
    return (
      `El comentario tiene ${edadDias.toFixed(0)} días. Facebook solo permite` +
      ' responder en privado dentro de los 7 días siguientes al comentario.'
    );
  }

  if (m.code === 10 || m.code === 200) {
    return (
      'La página no tiene permiso para enviar mensajes privados. Vuelve a' +
      ' conectarla en Canal de Conexiones.'
    );
  }

  return describirErrorMeta(err);
}

/**
 * "Responder en privado": abre un DM de Messenger con quien comentó.
 *
 * Meta sólo lo permite UNA vez por comentario, y por eso el resultado se guarda
 * en la fila. Sin ese registro la interfaz ofrecería el botón otra vez y el
 * segundo intento fallaría con un error que el usuario no puede interpretar.
 *
 * No abre la ventana de 24h de forma indefinida: es un único mensaje. La
 * conversación que se cree llegará por el webhook de Messenger como cualquier
 * otra y entrará al inbox por su camino normal.
 */
async function responderEnPrivado({
  id_configuracion,
  comment_id,
  mensaje,
  id_sub_usuario,
}) {
  const texto = String(mensaje || '').trim();
  if (!texto) throw new Error('El mensaje no puede estar vacío');

  const c = await cargarComentarioConToken({ id_configuracion, comment_id });
  if (!c) throw new Error('El comentario no existe en esta cuenta');
  if (c.es_de_la_pagina) {
    throw new Error('No se puede responder en privado a un comentario propio');
  }
  if (c.privado_enviado) {
    throw new Error('Ya se envió un mensaje privado por este comentario');
  }
  if (!c.page_access_token || c.page_status !== 'active') {
    throw new Error(
      'La página no tiene una conexión activa. Vuelve a conectarla en Canal de Conexiones.',
    );
  }

  try {
    // Se envía por la Send API, NO por `/{comment-id}/private_replies`.
    //
    // Ese edge era la forma original y hoy devuelve 100/33 ("does not support
    // this operation") aunque el comentario exista, sea de primer nivel y Meta
    // informe `can_reply_privately: true`. Comprobado contra v22.0 con el mismo
    // comentario y el mismo token: el edge viejo falla y este funciona.
    //
    // El error del edge viejo era además indistinguible de "comentario
    // borrado" o "fuera de plazo", que es lo que nos tuvo buscando en el sitio
    // equivocado.
    const { data } = await axios.post(
      `${GRAPH_BASE}/${encodeURIComponent(c.page_id)}/messages`,
      {
        recipient: { comment_id: c.comment_id },
        message: { text: texto },
      },
      {
        params: {
          access_token: c.page_access_token,
          appsecret_proof: appsecretProof(c.page_access_token, c.fb_app_id),
        },
        timeout: 20000,
      },
    );

    await db.query(
      `UPDATE facebook_comments
          SET privado_enviado = 1, privado_at = NOW(),
              privado_mid = ?, privado_error = NULL,
              respondido_por = COALESCE(respondido_por, ?)
        WHERE id_configuracion = ? AND comment_id = ?`,
      {
        replacements: [
          // La Send API responde { recipient_id, message_id }.
          data?.message_id || data?.id || null,
          id_sub_usuario || null,
          id_configuracion,
          comment_id,
        ],
        type: db.QueryTypes.UPDATE,
      },
    );

    console.log(
      `[FB_COMENT] ✅ privado enviado comment=${comment_id} · cfg=${id_configuracion}`,
    );
    return { privado_mid: data?.message_id || data?.id || null };
  } catch (err) {
    const edadDias = c.comentado_at
      ? (Date.now() - new Date(c.comentado_at).getTime()) / 864e5
      : undefined;
    const detalle = describirErrorPrivado(err, { edadDias });
    // El error se persiste, no sólo se devuelve: así la bandeja puede mostrar
    // por qué no salió sin que el usuario tenga que reintentar para enterarse.
    await db.query(
      `UPDATE facebook_comments SET privado_error = ?
        WHERE id_configuracion = ? AND comment_id = ?`,
      {
        replacements: [detalle.slice(0, 255), id_configuracion, comment_id],
        type: db.QueryTypes.UPDATE,
      },
    );
    console.error(
      `[FB_COMENT][ERROR] privado cfg=${id_configuracion} ` +
        `comment=${comment_id} · ${detalle}`,
    );
    throw new Error(detalle);
  }
}

module.exports = {
  procesarCambioFeed,
  guardarComentario,
  recalcularContadores,
  listarPosts,
  listarComentarios,
  resumen,
  responder,
  responderEnPrivado,
};
