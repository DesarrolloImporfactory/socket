// ════════════════════════════════════════════════════════════════════════
// puenteKanban.js
// Entrega al bot de kanban una conversación que nació en un comentario.
//
// EL PROBLEMA
//
// Cuando el asistente de comentarios manda un privado, la conversación de
// Messenger ya se crea (responderEnPrivado llama a ensureUnifiedConversation) y
// si el cliente contesta, su mensaje entra por el webhook y cae en
// runKanbanIaMS como cualquier otro. El bot ya se activa hoy.
//
// Lo que le falta es llegar sabiendo de qué hablaban. El cliente preguntó por
// un producto en una publicación, le escribimos al privado por ESE producto, y
// el bot abría la conversación en blanco.
//
// POR QUÉ ESTE CAMINO Y NO OTRO
//
// Un comentario en una publicación vinculada a un producto es lo mismo que un
// clic en un anuncio de ese producto, y para eso ya hay un camino rodado:
//
//   INSERT en cliente_productos_ad
//        ↓  trigger trg_ultimo_producto_ad
//   clientes_chat_center.ultimo_producto_ad + ultimo_producto_ad_at
//        ↓  kanban_ia.service.js
//   el bloque del producto se reinyecta en TODOS los turnos
//
// No hace falta inventar nada: se inserta la fila y el trigger hace el resto.
//
// Y encima se puede hacer mejor que un anuncio. El resolver de productos tiene
// un NIVEL 0 exacto (anuncios_producto, por source_id) y niveles de abajo que
// adivinan por parecido de texto — los que hicieron que "SSD PORTATIL DE 8TB"
// terminara cotizando una máquina de hielo. Un comentario no necesita adivinar:
// el producto está vinculado a mano a la publicación. Guardando el mapa
// source_id → id_producto, la resolución entra por el nivel 0 y no baja nunca.
//
// EL ESTADO DEL CONTACTO
//
// `contacto_inicial` es la primera columna del kanban. Ponerlo a ciegas borra
// el avance de alguien que ya está a medio cierre con un asesor, o que ya
// compró: el bot le arrancaría el guion de venta desde cero. Así que sólo se
// mueve cuando de verdad es una intención nueva (ver `decidirEstado`).
// ════════════════════════════════════════════════════════════════════════

const { db } = require('../../database/config');

/* Prefijo del `source_id` falso con el que se identifica una publicación.
   Es un espacio de nombres propio: nunca va a chocar con un ad id de Meta, y
   deja ver de un vistazo de dónde salió el vínculo. La columna es varchar(64)
   en las dos tablas, de ahí el recorte. */
const PREFIJO = 'fbpost:';
const TOPE_FUENTE = 64;

const fuenteDelPost = (post_id) =>
  `${PREFIJO}${String(post_id || '').trim()}`.slice(0, TOPE_FUENTE);

/**
 * Estados desde los que sí se puede reiniciar.
 *
 * Lo que NO está acá es un contacto con una venta viva —`asesor`,
 * `seguimiento`, `ia_ventas`, cualquier cosa que haya puesto el bot o una
 * persona— y a eso no se le toca el estado por un comentario.
 */
const ESTADOS_NEUTROS = new Set(['', 'contacto_inicial', 'nuevo']);

/**
 * Qué hacer con el estado del contacto.
 *
 * Lo que decide acá vale también para `bot_openia`: si el contacto está como
 * para reiniciar, el bot se enciende, y si no, no se toca. Ver el comentario
 * del UPDATE más abajo.
 *
 * Tres casos:
 *   - estado neutro → `contacto_inicial`. Es donde ya estaba, pero deja el
 *     chat abierto y el registro consistente.
 *   - chat cerrado → `contacto_inicial`. La conversación anterior terminó, y
 *     un comentario nuevo es una intención nueva. Mismo criterio que el
 *     webhook de WhatsApp cuando reabre un chat.
 *   - cualquier otra cosa → no se toca, y se devuelve el motivo para que
 *     quede en el log. Un comentario no interrumpe una venta en curso.
 */
function decidirEstado(contacto) {
  const estado = String(contacto?.estado_contacto || '').toLowerCase();

  if (ESTADOS_NEUTROS.has(estado)) {
    return { mover: true, motivo: 'contacto nuevo o sin avance' };
  }
  if (Number(contacto?.chat_cerrado) === 1) {
    return { mover: true, motivo: `chat cerrado en "${estado}"` };
  }
  return { mover: false, motivo: `venta en curso en "${estado}"` };
}

/**
 * Deja la conversación lista para que el bot de kanban la reciba.
 *
 * Nunca lanza: el privado ya salió a Facebook cuando esto corre. Que falle el
 * puente deja al bot sin contexto —malo—, pero hacer fallar el envío sería
 * peor: el agente creería que no se mandó y Facebook sólo permite uno por
 * comentario.
 *
 * @returns {Promise<object>} lo que se hizo, para el log y la respuesta HTTP
 */
async function entregarAlKanban({
  id_configuracion,
  id_cliente_contacto,
  producto, // { id, nombre } o null
  post_id,
  comentario, // el texto del comentario que originó todo
}) {
  const hecho = {
    ancla: null,
    estado: null,
    bot: null,
    mapa: false,
    error: null,
  };

  try {
    if (!id_configuracion || !id_cliente_contacto) return hecho;

    const [contacto] = await db.query(
      `SELECT estado_contacto, chat_cerrado, bot_openia
         FROM clientes_chat_center WHERE id = ? LIMIT 1`,
      { replacements: [id_cliente_contacto], type: db.QueryTypes.SELECT },
    );
    if (!contacto) return hecho;

    const fuente = post_id ? fuenteDelPost(post_id) : null;

    /* ── 1. El mapa anuncio→producto: el nivel 0 del resolver ──────────
       `via = 'manual'` porque es exactamente eso: una persona vinculó la
       publicación al producto desde la bandeja. No es una inferencia. */
    if (producto?.id && fuente) {
      await db.query(
        `INSERT INTO anuncios_producto
           (id_configuracion, source_id, id_producto, headline, via)
         VALUES (?, ?, ?, ?, 'manual')
         ON DUPLICATE KEY UPDATE
           id_producto = VALUES(id_producto),
           headline    = VALUES(headline),
           via         = VALUES(via),
           veces       = veces + 1`,
        {
          replacements: [
            id_configuracion,
            fuente,
            producto.id,
            String(producto.nombre || '').slice(0, 500),
          ],
          type: db.QueryTypes.INSERT,
        },
      );
      hecho.mapa = true;
    }

    /* ── 2. El ancla del producto ──────────────────────────────────────
       El trigger trg_ultimo_producto_ad copia headline y created_at a
       clientes_chat_center. De ahí lo lee el bot en cada turno.

       `mensaje_cliente` guarda el comentario: es el equivalente al primer
       mensaje del cliente en un clic de anuncio, y es lo que deja rastro de
       por qué este contacto quedó anclado a este producto. */
    if (producto?.nombre) {
      await db.query(
        `INSERT INTO cliente_productos_ad
           (id_cliente, id_configuracion, headline, source_id, mensaje_cliente)
         VALUES (?, ?, ?, ?, ?)`,
        {
          replacements: [
            id_cliente_contacto,
            id_configuracion,
            String(producto.nombre).slice(0, 500),
            fuente,
            String(comentario || '').slice(0, 2000) || null,
          ],
          type: db.QueryTypes.INSERT,
        },
      );
      hecho.ancla = producto.nombre;
    }

    /* ── 3. El estado y el bot ─────────────────────────────────────────
       El ancla va ANTES que esto a propósito: `anclaProductoVigente`
       descarta un ancla anterior a `reinicio_conversacion_at`, así que si
       alguna vez se reinicia la conversación acá, el orden importa. Hoy no
       se reinicia, pero el orden deja la puerta cerrada.

       SOBRE `bot_openia`. Al principio no se tocaba nunca, con el argumento
       de que si alguien apagó la IA de un chat fue por algo. La primera
       prueba real mostró el costo de esa prudencia: el contacto tenía el bot
       apagado, se le publicó "te escribo por el privado y ahí seguimos", se
       le escribió... y al contestar no le iba a responder nadie. Una promesa
       rota en público y en privado a la vez.

       Así que se enciende, pero sólo cuando el estado también se mueve —o
       sea cuando el contacto estaba nuevo o con el chat cerrado—. Si hay una
       venta en curso con un asesor, no se toca ni el estado ni el bot: ahí
       el apagado sí es una decisión viva de alguien. */
    const decision = decidirEstado(contacto);
    if (decision.mover) {
      await db.query(
        `UPDATE clientes_chat_center
            SET estado_contacto = 'contacto_inicial',
                chat_cerrado = 0,
                bot_openia = 1
          WHERE id = ?`,
        { replacements: [id_cliente_contacto], type: db.QueryTypes.UPDATE },
      );
      hecho.estado = 'contacto_inicial';
      hecho.bot = Number(contacto.bot_openia) === 1 ? 'ya estaba' : 'encendido';
    }

    console.log(
      `[FB_COMENT][PUENTE] cfg=${id_configuracion} contacto=${id_cliente_contacto} · ` +
        `producto=${producto?.id || '(ninguno)'} · ancla=${hecho.ancla || 'no'} · ` +
        `mapa=${hecho.mapa ? fuente : 'no'} · estado=${
          hecho.estado || `sin tocar (${decision.motivo})`
        }` +
        (hecho.bot ? ` · bot_openia ${hecho.bot}` : '') +
        (!decision.mover && Number(contacto.bot_openia) !== 1
          ? ' · ⚠️ bot_openia apagado y no se toca: el kanban no va a contestar'
          : ''),
    );
  } catch (err) {
    hecho.error = err.message;
    console.error(
      `[FB_COMENT][PUENTE][ERROR] cfg=${id_configuracion} ` +
        `contacto=${id_cliente_contacto} · ${err.message}`,
    );
  }

  return hecho;
}

module.exports = {
  entregarAlKanban,
  fuenteDelPost,
  decidirEstado,
  PREFIJO,
};
