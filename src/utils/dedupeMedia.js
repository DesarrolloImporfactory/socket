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
  VENTANA_REENVIO_HORAS,
};
