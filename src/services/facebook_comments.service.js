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
            ultimo_comentario_at
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

module.exports = {
  procesarCambioFeed,
  guardarComentario,
  recalcularContadores,
  listarPosts,
  listarComentarios,
  resumen,
};
