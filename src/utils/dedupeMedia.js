const { db } = require('../database/config');

/* Dedupe de la media que sale hacia el cliente.
 *
 * Vive acá y no dentro de cada camino porque tener el mismo control repetido en
 * dos lados fue justamente lo que rompió: el asistente de kanban filtraba y las
 * ramas `ventas` / `imporshop` del webhook de WhatsApp no, así que las cuentas
 * que no eran kanban recibían la misma foto en cada mensaje sin que nadie lo
 * viera en el código que sí estaba arreglado.
 *
 * La etiqueta `[producto_imagen_url]` puede venir del prompt (el modelo la
 * repite turno a turno) o del código que la adjunta solo. Este módulo es el
 * único punto por el que pasan las dos.
 */

// Cuánto tiempo cuenta como "ya se la mandamos".
//
// No es "una vez en la vida del contacto": esa versión dejaba sin foto a quien
// volvía a preguntar por el mismo producto días después, porque la consulta no
// miraba fecha y nada borra filas de `mensajes_clientes`. Con la ventana,
// seguir hablando del mismo producto no la repite, pero volver la semana
// siguiente sí la vuelve a recibir.
const VENTANA_REENVIO_HORAS = 48;

/* Media recién enviada, para el hueco que deja la consulta a la BD: entre que
   se decide enviar y que la fila queda guardada pasan un par de segundos, y en
   ese rato una segunda respuesta puede colarse con la misma foto.
   Dura poco a propósito: solo tapa la carrera, el "ya se la mandamos" sigue
   saliendo del historial del chat. */
const MEDIA_RECIENTE = new Map();
const VENTANA_MEMORIA_MS = 2 * 60 * 1000;

function recienEnviado(id_cliente, url) {
  const cuando = MEDIA_RECIENTE.get(`${id_cliente}|${url}`);
  return !!cuando && Date.now() - cuando < VENTANA_MEMORIA_MS;
}

function marcarEnviado(id_cliente, url) {
  const ahora = Date.now();
  MEDIA_RECIENTE.set(`${id_cliente}|${url}`, ahora);
  // Sin esto el Map crece para siempre en un proceso que no se reinicia.
  if (MEDIA_RECIENTE.size > 5000) {
    for (const [k, t] of MEDIA_RECIENTE) {
      if (ahora - t >= VENTANA_MEMORIA_MS) MEDIA_RECIENTE.delete(k);
    }
  }
}

/* Se llama cuando el envío falló: no quedó fila en `mensajes_clientes`, así que
   la marca estaría bloqueando una foto que el cliente nunca recibió. */
function olvidarEnviado(id_cliente, url) {
  MEDIA_RECIENTE.delete(`${id_cliente}|${url}`);
}

/* Al reiniciar la conversación hay que soltar también las marcas en memoria: la
   consulta a la BD ya ignora lo anterior al reinicio, pero el Map no sabe nada
   de eso y bloquearía la foto los dos minutos siguientes. */
function olvidarCliente(id_cliente) {
  const prefijo = `${id_cliente}|`;
  for (const k of MEDIA_RECIENTE.keys()) {
    if (k.startsWith(prefijo)) MEDIA_RECIENTE.delete(k);
  }
}

/* ¿Existe ya la columna que marca el reinicio de conversación?
   `reinicio_conversacion_migration.sql` se aplica a mano, así que entre que
   este código sube y la columna existe puede pasar un rato. Si la consultáramos
   a ciegas, la query fallaría, el catch de abajo dejaría pasar la foto igual y
   volveríamos a mandar imágenes repetidas — justo lo que esto evita. Por eso se
   comprueba y se recuerda; mientras no esté, rige solo la ventana de 48 h. */
let columnaReinicio = null; // null = todavía no se comprobó
let ultimaComprobacion = 0;
const REINTENTO_COMPROBACION_MS = 5 * 60 * 1000;

async function hayColumnaReinicio() {
  if (columnaReinicio === true) return true;

  const ahora = Date.now();
  if (
    columnaReinicio === false &&
    ahora - ultimaComprobacion < REINTENTO_COMPROBACION_MS
  ) {
    return false;
  }
  ultimaComprobacion = ahora;

  try {
    const filas = await db.query(
      `SHOW COLUMNS FROM clientes_chat_center LIKE 'reinicio_conversacion_at'`,
      { type: db.QueryTypes.SELECT },
    );
    columnaReinicio = filas.length > 0;
  } catch {
    columnaReinicio = false;
  }
  return columnaReinicio;
}

/* En LIKE, `_` y `%` son comodines. Las urls que arma multer traen guiones
   bajos, así que sin escapar, la foto de un producto puede dar match con la de
   otro y quedar bloqueada la que sí tocaba enviar. */
const escaparLike = (s) => String(s).replace(/[\\%_]/g, '\\$&');

/* ══ Candado de propiedad: la foto tiene que ser DEL producto en juego ══

   Caso real (285, 2026-08-17): el cliente preguntó "¿protege la cabeza?"
   hablando de la máscara táctica, file_search recuperó por semántica el
   fragmento del "Intercomunicador Bluetooth para CASCO" —con su URL de imagen
   adentro— y el bot mandó ESA foto. El texto nunca se equivocó; la URL sí.

   La regla, aplicada acá porque este es el único punto por el que sale toda
   la media: si una URL pertenece a un producto del catálogo, solo se envía
   cuando ese producto está de verdad en esta conversación —el sistema se lo
   ofreció al modelo (ficha/ancla/adjunto), es el producto del anuncio por el
   que entró el cliente, o su nombre completo aparece en los mensajes
   recientes—. Una URL que el modelo sacó de un fragmento, de la memoria del
   hilo o de su imaginación no cumple ninguna de las tres y muere acá,
   venga del prompt o del código.

   Las URLs que NO son de catálogo (documentos, plantillas, calendario…)
   pasan sin mirar: este candado solo juzga lo que puede identificar. */

const VENTANA_OFERTA_MS = 72 * 60 * 60 * 1000;
const MEDIA_OFRECIDA = new Map(); // `${id_cliente}|${filename}` → timestamp

/* La llave es el NOMBRE DE ARCHIVO (último segmento, decodificado): la misma
   url viaja a veces cruda y a veces con el filename percent-encoded
   (normalizarUrlMedia), y comparar la cadena completa dejaría pasar o
   bloquearía según cuál forma tocó. Los nombres son UUIDs: identifican solos. */
const filenameDe = (url) => {
  const raw = String(url || '').split('?')[0].split('/').pop() || '';
  try {
    return decodeURIComponent(raw).trim().toLowerCase();
  } catch {
    return raw.trim().toLowerCase();
  }
};

/** El sistema le puso esta media delante al modelo: queda autorizada a salir. */
function ofrecerMedia(id_cliente, urls) {
  const ahora = Date.now();
  for (const u of [].concat(urls || [])) {
    const f = filenameDe(u);
    if (f) MEDIA_OFRECIDA.set(`${id_cliente}|${f}`, ahora);
  }
  if (MEDIA_OFRECIDA.size > 20000) {
    for (const [k, t] of MEDIA_OFRECIDA) {
      if (ahora - t >= VENTANA_OFERTA_MS) MEDIA_OFRECIDA.delete(k);
    }
  }
}

const fueOfrecida = (id_cliente, filename) => {
  const t = MEDIA_OFRECIDA.get(`${id_cliente}|${filename}`);
  return !!t && Date.now() - t < VENTANA_OFERTA_MS;
};

/* Copia mínima del normalizar de contextoColumna. No se importa de ahí porque
   contextoColumna requiere este módulo (para ofrecerMedia) y sería un ciclo. */
const normalizarTexto = (s) =>
  String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * ¿Esta URL puede salir hacia este cliente?
 * Exportada aparte para poder probarla directo en la batería de regresión.
 */
async function esMediaPermitida({ id_configuracion, id_cliente, url, log }) {
  const decir = typeof log === 'function' ? log : async () => {};
  const f = filenameDe(url);

  // Sin cuenta o sin un filename identificable no hay a quién atribuirla.
  if (!id_configuracion || !f || f.length < 10) return true;

  // (a) El sistema se la ofreció al modelo en esta conversación.
  if (fueOfrecida(id_cliente, f)) return true;

  // ¿De qué producto es? Si no es de ningún producto, no es jurisdicción de
  // este candado (documentos, plantillas, media manual…).
  let dueno = null;
  try {
    const patron = `%${escaparLike(f)}%`;
    [dueno] = await db.query(
      `SELECT id, nombre FROM productos_chat_center
        WHERE id_configuracion = ? AND eliminado = 0
          AND (imagen_url LIKE ? ESCAPE '\\\\'
            OR video_url LIKE ? ESCAPE '\\\\'
            OR imagen_upsell_url LIKE ? ESCAPE '\\\\')
        LIMIT 1`,
      {
        replacements: [id_configuracion, patron, patron, patron],
        type: db.QueryTypes.SELECT,
      },
    );
  } catch (e) {
    // Ante un error de BD se deja pasar, igual que el dedupe: bloquear una
    // foto legítima por un timeout sería castigar al cliente por nuestra falla.
    return true;
  }
  if (!dueno) return true;

  // (b) Es el producto del anuncio por el que entró este cliente.
  try {
    const [ad] = await db.query(
      `SELECT headline, source_id FROM cliente_productos_ad
        WHERE id_cliente = ? ORDER BY id DESC LIMIT 1`,
      { replacements: [id_cliente], type: db.QueryTypes.SELECT },
    );
    if (ad) {
      const {
        resolverProductoAnuncio,
      } = require('./webhook_whatsapp/buscar_producto_referral');
      const r = await resolverProductoAnuncio(
        id_configuracion,
        ad.headline,
        ad.source_id,
      );
      if (r?.producto?.id && Number(r.producto.id) === Number(dueno.id)) {
        return true;
      }
    }
  } catch (_) {}

  // (c) Su nombre completo aparece en la conversación reciente. Un nombre muy
  // corto no alcanza para contención confiable: en ese caso no se bloquea.
  try {
    const nombre = normalizarTexto(dueno.nombre);
    if (nombre.length <= 8) return true;
    const msgs = await db.query(
      `SELECT texto_mensaje FROM mensajes_clientes
        WHERE id_configuracion = ? AND ${COLUMNA_CONTACTO} = ?
          AND texto_mensaje IS NOT NULL AND texto_mensaje <> ''
        ORDER BY id DESC LIMIT 30`,
      {
        replacements: [id_configuracion, String(id_cliente)],
        type: db.QueryTypes.SELECT,
      },
    );
    for (const m of msgs) {
      if (normalizarTexto(m.texto_mensaje).includes(nombre)) return true;
    }
  } catch (e) {
    return true;
  }

  await decir(
    `🚫 La media pertenece a "${dueno.nombre}", que no está en esta conversación: no se envía`,
  );
  return false;
}

/* La conversación se busca por `celular_recibe`, NO por `id_cliente`.
   En `mensajes_clientes` las dos columnas guardan un id de
   `clientes_chat_center`, pero no el mismo: `id_cliente` es SIEMPRE el dueño
   (la fila `propietario = 1` de la cuenta, la misma para todos sus contactos) y
   `celular_recibe` —el nombre engaña, no es un teléfono— es el contacto. Vale
   para los dos sentidos y para los tres canales; ver
   `procesarMensajeTexto` (WhatsApp) y `saveOutgoingMessageUnified` (MS/IG),
   que lo dejan escrito: "id_cliente = dueño, celular_recibe = contacto".

   Preguntando por `id_cliente = <contacto>` la consulta no devolvía NUNCA una
   fila, así que el dedupe contra el historial era letra muerta: lo único que
   frenaba la foto repetida era el Map de 2 minutos de acá arriba. Por eso la
   imagen volvía "en cada mensaje o cada dos", según lo que tardara la persona
   en contestar, y por eso parecía arreglado al probarlo a mensaje seguido.

   La url puede estar en dos sitios según el canal: WhatsApp la guarda en
   `ruta_archivo` y Messenger/Instagram la dejan dentro del JSON de
   `attachments_unificado`. Se miran los dos o el dedupe seguiría sin existir
   para esos dos canales. */
const COLUMNA_CONTACTO = 'celular_recibe';

/**
 * Filtra las urls que ya se le enviaron a este cliente hace poco.
 *
 * @param {object}   p
 * @param {number}   p.id_cliente        id del CONTACTO en clientes_chat_center
 * @param {number}   [p.id_configuracion] la cuenta; sin él la consulta no puede
 *                                        usar el índice y barre la tabla
 * @param {string[]} p.urls       urls candidatas, en orden
 * @param {string}   p.etiqueta   'imagen' | 'video', solo para el log
 * @param {Function} [p.log]      async (msg) => void
 * @returns {Promise<string[]>}   las que sí hay que enviar
 */
async function filtrarMediaNueva({
  id_cliente,
  id_configuracion = null,
  urls,
  etiqueta = 'media',
  log,
}) {
  const decir = typeof log === 'function' ? log : async () => {};
  const vistas = new Set();
  const salida = [];

  /* El corte es el más reciente entre "hace 48 h" y "cuando se reinició la
     conversación": reiniciar deja al bot presentando el producto desde cero, y
     la foto es parte de esa presentación. Se resuelve en SQL y no comparando
     fechas en JS para no mezclar el reloj del proceso con el de la BD. */
  const conReinicio = await hayColumnaReinicio();
  const corteVentana = conReinicio
    ? `GREATEST(
           DATE_SUB(NOW(), INTERVAL ? HOUR),
           COALESCE(
             (SELECT reinicio_conversacion_at FROM clientes_chat_center
               WHERE id = ?),
             '1970-01-01 00:00:00'
           )
         )`
    : `DATE_SUB(NOW(), INTERVAL ? HOUR)`;

  for (const url of urls || []) {
    if (!url) continue;
    if (vistas.has(url)) continue; // repetida dentro del mismo mensaje
    vistas.add(url);

    if (recienEnviado(id_cliente, url)) {
      await decir(`🔁 ${etiqueta} recién enviado, se omite`);
      continue;
    }

    /* Candado de propiedad (ver arriba): media de un producto que no está en
       esta conversación no sale, venga de donde venga la etiqueta. Va ANTES
       de marcarEnviado: una url bloqueada no debe quedar marcada como
       enviada. */
    if (!(await esMediaPermitida({ id_configuracion, id_cliente, url, log: decir }))) {
      continue;
    }

    /* La marca va ANTES de la consulta, no después. La fila del envío se guarda
       recién cuando el mensaje ya salió, así que si el cliente escribe dos veces
       seguidas y las dos respuestas se cruzan, las dos llegan a preguntarle a la
       BD antes de que ninguna haya guardado nada y las dos reciben "todavía no
       se envió". Marcando de este lado del `await`, la segunda ya encuentra la
       marca de la primera. */
    marcarEnviado(id_cliente, url);

    try {
      const patron = `%${escaparLike(url)}%`;
      /* `mensajes_clientes` es de las tablas grandes del sistema y esto corre en
         cada turno del bot. El índice que ya existe
         (`idx_mc_conf_cel_rol_del_at`, ver dashboard_indexes_migration.sql)
         arranca por `id_configuracion`, así que sin esa condición la consulta
         no lo alcanza y termina en escaneo completo. */
      const filtroCuenta = id_configuracion ? `id_configuracion = ? AND` : '';
      const [existe] = await db.query(
        `SELECT id FROM mensajes_clientes
          WHERE ${filtroCuenta} ${COLUMNA_CONTACTO} = ?
            AND rol_mensaje = 1
            AND deleted_at IS NULL
            AND created_at >= ${corteVentana}
            AND (
              ruta_archivo LIKE ? ESCAPE '\\\\'
              OR attachments_unificado LIKE ? ESCAPE '\\\\'
            )
          LIMIT 1`,
        {
          replacements: [
            ...(id_configuracion ? [id_configuracion] : []),
            /* `celular_recibe` es VARCHAR aunque lleve un id: si se le pasa un
               número, MySQL convierte la columna entera para comparar y se
               queda sin índice. */
            String(id_cliente),
            VENTANA_REENVIO_HORAS,
            ...(conReinicio ? [id_cliente] : []),
            patron,
            patron,
          ],
          type: db.QueryTypes.SELECT,
        },
      );
      if (existe) {
        await decir(
          `🔁 ${etiqueta} ya enviado en las últimas ${VENTANA_REENVIO_HORAS} h, se omite`,
        );
        continue;
      }
    } catch (e) {
      /* Ante un error de BD se deja pasar: peor que una foto repetida es que el
         cliente se quede sin ver el producto. */
      await decir(`⚠️ No se pudo verificar ${etiqueta} repetido: ${e.message}`);
    }

    salida.push(url);
  }

  return salida;
}

module.exports = {
  filtrarMediaNueva,
  olvidarEnviado,
  olvidarCliente,
  ofrecerMedia,
  esMediaPermitida,
  VENTANA_REENVIO_HORAS,
};
