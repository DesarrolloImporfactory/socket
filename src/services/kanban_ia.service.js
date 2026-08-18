// services/kanban_ia.service.js
// Función genérica que reemplaza todo el switch ventas/eventos/imporfactory.
// Lee el assistant_id y las acciones desde kanban_columnas + kanban_acciones,
// ejecuta el asistente OpenAI y procesa todas las acciones configuradas.
// ─────────────────────────────────────────────────────────────

const axios = require('axios');
const flatted = require('flatted');
const { db } = require('../database/config');
const { verificarAccesoAutomatizaciones } = require('../utils/planAcceso');
const { construirContextoColumna } = require('../utils/contextoColumna');
const { limpiarColetillas } = require('../utils/limpiarColetillas');
const {
  filtrarMediaNueva,
  olvidarEnviado,
  ofrecerMedia,
} = require('../utils/dedupeMedia');
const { extraerUrlsMedia, normalizarUrlMedia } = require('../utils/urlsMedia');
const { humanizarFechas } = require('../utils/humanizarFechas');
const { limpiarMarkdown } = require('../utils/formatoWhatsapp');
const {
  toolFileSearchResponses,
  usaCatalogoInline,
  catalogoInlineActivo,
  TOPE_CATALOGO_INLINE,
} = require('../utils/openia/fileSearch');
const {
  usaResponsesApi,
  usaRecapConversacion,
} = require('../utils/openia/responsesApi');

const {
  enviarMensajeWhatsapp,
} = require('../utils/webhook_whatsapp/enviarMensajes');

const {
  sanitizarRespuestaAgente,
} = require('../utils/openia/sanitizador_agente');

// Envío de la respuesta repartida en 2-3 mensajes (gated por configuración)
const {
  enviarEnBloques,
  nuevoTurno,
} = require('../utils/openia/envioEnBloques');

// La lista de configs con inline y el tope de tokens viven en
// utils/openia/fileSearch.js, porque el servicio de sincronización decide con
// los mismos números. Se importan arriba junto con toolFileSearchResponses.

// Puente entre el prompt y el catálogo inline.
//
// Los prompts existentes están escritos contra file_search y lo nombran a cada
// rato ("file_search es tu fuente de verdad", "el nombre EXACTO como aparece en
// file_search", "si file_search NO devuelve combos..."). Solo en la columna
// 6554 de la config 10 son 11 menciones.
//
// Con inline el catálogo ya no viaja por esa herramienta, así que el prompt
// apunta a algo que no está. En vez de reescribir los prompts —que los mantiene
// otra persona y viven en la DB, no en el repo— se traduce el término aquí.
// Sale más barato y no rompe a quien siga en file_search: este texto solo se
// pega cuando usarInline es true.
//
// ⚠️ NO puede decir "no tienes la herramienta file_search". Eso era cierto
// mientras el inline existía solo en la rama de la Responses API, donde las
// tools se arman por llamada. En la rama de Assistants las tools viven en el
// asistente, y las cuentas con documentos propios conservan file_search para
// su vector store de documentos: decirle al modelo que no la tiene lo llevaría
// a no buscar nunca en esos archivos. Por eso el texto habla de DÓNDE está el
// catálogo, no de qué herramientas existen.
const PUENTE_INLINE =
  'NOTA SOBRE EL CATÁLOGO: el catálogo NO está en file_search. Donde estas ' +
  'instrucciones digan "file_search" refiriéndose a productos, precios, ' +
  'combos, variedades o URLs, se refieren al catálogo que viene a ' +
  'continuación: ya lo tienes COMPLETO aquí abajo, no hay nada que buscar. ' +
  'Trátalo con las mismas reglas: es tu única fuente de verdad sobre el ' +
  'catálogo; si un producto no está en él, no existe; nunca inventes nada que ' +
  'no aparezca escrito ahí. Si además tienes la herramienta file_search ' +
  'disponible, contiene únicamente documentos de apoyo (guías, agencias, ' +
  'políticas), NO el catálogo: úsala solo para eso.';

// Auto-creación de órdenes en Dropi cuando el bot confirma la venta
const {
  autoCrearOrdenDropi,
  autoActualizarOrdenDropi,
} = require('./dropiAutoOrder.service');

// Agrupa los mensajes que el cliente manda en ráfaga en un solo turno de IA
const { esperarRafaga } = require('../utils/agruparRafaga');

// Candados para que dos cierres seguidos no creen dos órdenes ni manden el
// resumen del pedido dos veces
const {
  reclamarAutoOrden,
  confirmarAutoOrden,
  liberarAutoOrden,
  reclamarResumenCierre,
} = require('../utils/dedupeAutoOrden');

// ══════════════════════════════════════════════════════════════
// fetchAssistantInfo — devuelve el prompt de la BD (kanban_columnas)
//
// ⚠️ El nombre y el comentario viejo decían "trae el prompt REAL cargado en
// OpenAI". Es falso y confunde justo donde más caro sale: NO llama a OpenAI,
// lee kanban_columnas.instrucciones. Tampoco es solo para debugging — lo que
// devuelve es lo que se manda como `instructions` en la Responses API.
//
// Ahí está la asimetría que hay que tener presente al migrar:
//   Assistants API → el prompt vive DENTRO del assistant, en OpenAI.
//                    kanban_columnas.instrucciones no lo lee nadie.
//   Responses API  → el prompt sale de la BD. El de OpenAI se ignora.
//
// O sea que pasar una cuenta de una API a la otra CAMBIA cuál de las dos
// copias manda. Si divergieron mientras nadie miraba la de la BD, el bot
// cambia de comportamiento al migrar, sin ningún error.
// (Auditado el 2026-08-11: 22 de 769 columnas habían divergido; ver
// scripts/auditarMigracionResponsesApi.js.)
// ══════════════════════════════════════════════════════════════
async function fetchAssistantInfo(id_columna) {
  const [col] = await db.query(
    `SELECT instrucciones, modelo FROM kanban_columnas 
     WHERE id = ? AND activo = 1 LIMIT 1`,
    { replacements: [id_columna], type: db.QueryTypes.SELECT },
  );
  return {
    instructions: col?.instrucciones || '',
    model: col?.modelo || 'gpt-4o-mini',
    instructions_length: (col?.instrucciones || '').length,
    tools: '',
    name: 'asistente',
  };
}

const {
  enviarMedioWhatsapp,
} = require('../utils/webhook_whatsapp/enviarMultimedia');

const {
  obtenerUltimoResponseId,
  guardarResponseId,
} = require('../services/obtener_response.service');

/* El alta de la cita es compartida con la confirmación manual de solicitudes:
   acá solo se lee el bloque que escribió el modelo y se le pasan los datos. */
const { crearCitaAgendada } = require('./citas_agenda.service');

const logsDir = require('path').join(process.cwd(), './src/logs/logs_meta');
const fs = require('fs').promises;

// Detector compartido: antes había una copia acá y otra en el cron, y se
// separaron por una sola línea (la de acá no miraba err.message). Ver el
// encabezado de utils/openia/sinSaldo.js.
const {
  esSinSaldoOpenAI: esSinSaldo,
  mensajeErrorOpenAI,
} = require('../utils/openia/sinSaldo');

// La Responses API acumula historial vía previous_response_id; con muchos
// turnos + file_search el contexto puede superar la ventana del modelo.
function esContextoExcedido(err) {
  const code = err?.response?.data?.error?.code;
  const msg = err?.response?.data?.error?.message || err?.message || '';
  return (
    code === 'context_length_exceeded' ||
    /context window|context_length|maximum context/i.test(msg)
  );
}

// Reconstruye un transcript compacto de la conversación desde NUESTRA BD.
// Se usa para re-sembrar el contexto cuando se resetea el hilo por
// context_length_exceeded, de modo que el asistente NO pierda de qué producto
// se habló ni los datos del cliente (nombre, dirección, etapa de la venta).
// Lo que infla el contexto son los trozos de file_search, no este diálogo.
async function construirRecapConversacion(id_cliente, maxMsgs = 30) {
  try {
    const limite = Number(maxMsgs) || 30;
    const rows = await db.query(
      `SELECT rol_mensaje, texto_mensaje
         FROM mensajes_clientes
        WHERE celular_recibe = ?
          AND texto_mensaje IS NOT NULL
          AND texto_mensaje <> ''
          AND deleted_at IS NULL
        ORDER BY id DESC
        LIMIT ${limite}`,
      { replacements: [String(id_cliente)], type: db.QueryTypes.SELECT },
    );
    if (!rows.length) return '';
    return rows
      .reverse()
      .map((m) => {
        const quien = Number(m.rol_mensaje) === 1 ? 'Asistente' : 'Cliente';
        const txt = String(m.texto_mensaje || '')
          .slice(0, 500)
          .trim();
        return txt ? `${quien}: ${txt}` : null;
      })
      .filter(Boolean)
      .join('\n');
  } catch (_) {
    return '';
  }
}

/* ¿El cierre de venta trae datos de verdad, o el modelo copió la plantilla?
   Solo se pregunta cuando la respuesta trae el trigger de generar_guia: cerrar
   una venta mueve columna y dispara el auto-orden de Dropi, así que un resumen
   con placeholders no puede contar como cierre.

   Se revisan las señales de plantilla copiada, no la completitud campo por
   campo (el auto-orden ya completa faltantes con su extractor): corchetes
   tipo "[nombre completo real]" —quitando antes los tags del sistema y de
   media, que también usan corchetes— y las frases de relleno que el arnés de
   prompts ya cazaba en las pruebas. Devuelve el motivo, o null si el cierre
   es válido. */
const RE_TAGS_SISTEMA = /\[[a-z_]+\]\s*:\s*(?:true|false)/gi;
const RE_TAGS_MEDIA =
  /\[(?:producto|servicio|upsell)_(?:imagen|video)_url\]\s*:[^\n]*/gi;

function motivoCierreInvalido(respuesta) {
  const texto = String(respuesta || '')
    .replace(RE_TAGS_SISTEMA, '')
    .replace(RE_TAGS_MEDIA, '');

  if (/\[[^\[\]\n]{3,60}\]/.test(texto)) {
    return 'placeholders del prompt en el resumen';
  }
  if (
    /\(pendiente\)|\(falta\)|no proporcionad|por favor proporciona|seg[uú]n tu elecci[oó]n/i.test(
      texto,
    )
  ) {
    return 'texto de relleno en el resumen';
  }
  const nombre = texto.match(/🧑?\s*Nombre:\s*([^\n]+)/i)?.[1];
  if (nombre !== undefined && nombre.replace(/[*_\s]/g, '') === '') {
    return 'línea de nombre vacía';
  }
  return null;
}

async function marcarOpenAIInactivo(id_configuracion, motivo) {
  try {
    await db.query(
      `UPDATE configuraciones
       SET openai_activo = 0,
           openai_error_at = NOW(),
           openai_error_msg = ?
       WHERE id = ?`,
      {
        replacements: [
          motivo?.slice(0, 500) || 'Error desconocido',
          id_configuracion,
        ],
        type: db.QueryTypes.UPDATE,
      },
    );
    await log(`🔴 OpenAI marcado INACTIVO para config=${id_configuracion}`);
  } catch (err) {
    await log(`⚠️ No se pudo marcar openai_activo=0: ${err.message}`);
  }
}

async function marcarOpenAIActivo(id_configuracion) {
  try {
    await db.query(
      `UPDATE configuraciones
       SET openai_activo = 1,
           openai_error_at = NULL,
           openai_error_msg = NULL
       WHERE id = ? AND openai_activo = 0`,
      {
        replacements: [id_configuracion],
        type: db.QueryTypes.UPDATE,
      },
    );
  } catch (err) {
    await log(`⚠️ No se pudo marcar openai_activo=1: ${err.message}`);
  }
}

async function log(msg) {
  await fs.mkdir(logsDir, { recursive: true });
  await fs.appendFile(
    require('path').join(logsDir, 'debug_log.txt'),
    `[${new Date().toISOString()}] [kanban_ia] ${msg}\n`,
  );
}

// ─────────────────────────────────────────────────────────────
// procesarMensajeKanban
// Punto de entrada único desde el webhook.
//
// @param {object} params
//   id_configuracion, id_cliente, telefono, mensaje,
//   estado_contacto, api_key_openai,
//   business_phone_id, accessToken
//
// @returns {object} { ok, respuesta_enviada }
// ─────────────────────────────────────────────────────────────
async function procesarMensajeKanban(params) {
  const {
    id_configuracion,
    id_cliente,
    telefono,
    estado_contacto,
    api_key_openai,
    business_phone_id,
    accessToken,
    bloque_producto_referral,
  } = params;

  // `let` porque la agrupación de ráfaga (más abajo) lo reemplaza por el texto
  // completo del cliente cuando escribió en varios mensajes seguidos.
  let { mensaje } = params;

  // ── Canal de salida ───────────────────────────────────────
  // Por defecto = WhatsApp (mismo comportamiento estable de siempre).
  // Otros canales (Instagram, Messenger…) inyectan su propio adaptador
  // vía params.canal para reutilizar TODO el cerebro de la IA kanban.
  //   canal.enviarTexto({ texto, responsable, total_tokens })
  //   canal.enviarMedia({ tipo: 'image'|'video', url, responsable })
  const canal = params.canal || {
    source: 'wa',
    enviarTexto: async ({ texto, responsable, total_tokens }) =>
      enviarMensajeWhatsapp({
        phone_whatsapp_to: telefono,
        texto_mensaje: texto,
        business_phone_id,
        accessToken,
        id_configuracion,
        responsable,
        total_tokens,
      }),
    enviarMedia: async ({ tipo, url, responsable }) => {
      /* `enviarMedioWhatsapp` no lanza: devuelve `{ ok, error }`. Acá sí se
         convierte en excepción porque los adaptadores de MS e IG fallan
         lanzando, y el `.catch` del paso 12 —el que suelta la marca del
         dedupe— es común a los tres. Sin esto, para WhatsApp ese catch no se
         ejecutaba nunca y una foto rechazada por Meta quedaba marcada como
         enviada. */
      const r = await enviarMedioWhatsapp({
        tipo,
        url_archivo: url,
        phone_whatsapp_to: telefono,
        business_phone_id,
        accessToken,
        id_configuracion,
        responsable,
      });
      if (r && r.ok === false) {
        throw new Error(r.error || 'Meta rechazó el envío');
      }
      return r;
    },
  };

  // ── 0. Corta-fuegos por plan ──────────────────────────────
  // El webhook de Meta no pasa por checkPlanActivo (lo llama Meta, no el
  // cliente), así que este es el único punto donde se puede cortar el bot.
  // Es punto de entrada único de los 3 canales (WA, MS e IG lo reusan), así
  // que con este gate queda cubierto todo el cerebro de la IA y, de paso, las
  // auto-órdenes de Dropi que dispara. El mensaje entrante YA se guardó antes
  // de llegar aquí: el cliente no pierde la conversación, solo deja de
  // responderse solo.
  const acceso = await verificarAccesoAutomatizaciones(id_configuracion);
  if (!acceso.permitido) {
    await log(
      `🚫 Automatizaciones cortadas para config=${id_configuracion} (${acceso.motivo}). No se ejecuta la IA.`,
    );
    return { ok: false, motivo: `plan_bloqueado:${acceso.motivo}` };
  }

  /* ── 0.05 Interruptor general del bot ─────────────────────
     El switch de la pantalla de Asistentes. Existía y no hacía nada para las
     cuentas con tablero: apagarlo ahí no callaba al bot, había que entrar
     columna por columna a bajar la IA. Ahora manda sobre todas.

     Una cuenta recién creada NO tiene fila, y eso significa apagado: el bot
     empieza en silencio y habla recién cuando el cliente lo enciende. Nadie
     quiere que un bot se ponga a contestarle a sus clientes antes de que él
     revise el prompt. Las cuentas que ya estaban respondiendo cuando esto se
     implementó recibieron su fila encendida, así que a nadie se le calló el bot
     de un día para otro. */
  const [interruptor] = await db.query(
    `SELECT activo FROM openai_assistants
      WHERE id_configuracion = ? AND tipo = 'ventas' AND deleted_at IS NULL
      LIMIT 1`,
    { replacements: [id_configuracion], type: db.QueryTypes.SELECT },
  );

  if (!interruptor || Number(interruptor.activo) === 0) {
    await log(
      `🔌 Bot apagado para config=${id_configuracion} (${interruptor ? 'apagado desde Asistentes' : 'nunca se activó'}). No se ejecuta la IA.`,
    );
    return { ok: false, motivo: 'bot_apagado' };
  }

  // ── 0.1 Decidir qué API usar ──────────────────────────────
  const USAR_RESPONSES_API = usaResponsesApi(id_configuracion);

  /* ── Agrupar la ráfaga ────────────────────────────────────
     Si el cliente escribe en pedazos, cada mensaje llega acá por separado y
     antes corrían dos turnos en paralelo: dos llamadas a OpenAI y el bot
     contestando dos veces. Ahora se espera una ventana corta; si llega otro
     mensaje, esta corrida se retira y la nueva contesta con TODO el texto.

     Va después de los gates de plan e interruptor —que son baratos y cortan
     antes de gastar la espera— y antes de todo el trabajo real.

     Ver el costo en latencia y la medición que fijó la ventana en
     utils/agruparRafaga.js. */
  const mensajeAgrupado = await esperarRafaga(id_cliente, mensaje);
  if (mensajeAgrupado === null) {
    await log(
      `⏸️ Ráfaga: el cliente ${id_cliente} siguió escribiendo; este turno se ` +
        `retira y contesta el último con todo el texto junto`,
    );
    return { ok: true, motivo: 'absorbido_en_rafaga' };
  }
  if (mensajeAgrupado !== mensaje) {
    await log(
      `🧩 Ráfaga agrupada para cliente=${id_cliente}: "${String(mensajeAgrupado).slice(0, 160)}"`,
    );
    mensaje = mensajeAgrupado;
  }

  // Llegó un mensaje nuevo de este cliente: invalida cualquier ráfaga que
  // haya quedado pendiente de la respuesta anterior.
  const turno = nuevoTurno(id_cliente);

  // ── 1. Obtener configuración de la columna activa ─────────
  const [columna] = await db.query(
    `SELECT kc.id, kc.nombre, kc.assistant_id, kc.activa_ia,
            kc.max_tokens, kc.vector_store_id, kc.vector_store_docs_id,
            kc.es_dropi_principal,
            kc.catalogo_inline, kc.catalogo_inline_tokens
     FROM   kanban_columnas kc
     WHERE  kc.id_configuracion = ?
       AND  LOWER(kc.estado_db) = LOWER(?)
       AND  kc.activo = 1
     LIMIT 1`,
    {
      replacements: [id_configuracion, estado_contacto],
      type: db.QueryTypes.SELECT,
    },
  );

  if (!columna) {
    await log(
      `⚠️ Sin columna para estado=${estado_contacto} config=${id_configuracion}`,
    );
    return { ok: false, motivo: 'sin_columna' };
  }

  if (!columna.activa_ia || !columna.assistant_id) {
    await log(
      `ℹ️ IA inactiva para columna "${columna.nombre}" (activa_ia=${columna.activa_ia})`,
    );
    return { ok: false, motivo: 'ia_inactiva' };
  }

  // 🔍 DEBUG: ver qué assistant está corriendo REALMENTE
  const assistantInfo = await fetchAssistantInfo(columna.id);
  await log(
    `🤖 DEBUG ASSISTANT — columna="${columna.nombre}" id=${columna.assistant_id} name="${assistantInfo.name}" model="${assistantInfo.model}" tools=[${assistantInfo.tools}] instructions_len=${assistantInfo.instructions_length}`,
  );
  await log(`📝 Instructions len=${assistantInfo.instructions_length}`);

  /* Columna con IA prendida pero SIN prompt: sería un modelo desnudo hablándole
     al cliente —inventa precios, promete horarios y nunca escribe los tags, así
     que la ficha además se queda atascada. Solo aplica al camino de Responses,
     que es el único donde el prompt sale de la BD; por el camino viejo el prompt
     vive en el assistant de OpenAI y `instrucciones` es apenas una copia local
     que en varias cuentas antiguas nunca se llenó. */
  if (USAR_RESPONSES_API && !String(assistantInfo.instructions || '').trim()) {
    await log(
      `🚫 Columna "${columna.nombre}" (id=${columna.id}, config=${id_configuracion}) tiene IA activa pero el prompt está VACÍO. No se ejecuta: se deja para atención humana.`,
    );
    return { ok: false, motivo: 'sin_instrucciones' };
  }

  // ── 2. Obtener acciones configuradas para esta columna ────
  const acciones = await db.query(
    `SELECT tipo_accion, config, orden
     FROM   kanban_acciones
     WHERE  id_kanban_columna = ? AND activo = 1
     ORDER  BY orden ASC`,
    { replacements: [columna.id], type: db.QueryTypes.SELECT },
  );

  const tieneAccion = (tipo) => acciones.some((a) => a.tipo_accion === tipo);
  const getAcciones = (tipo) => acciones.filter((a) => a.tipo_accion === tipo);
  const parseConfig = (a) => {
    try {
      let cfg = a?.config;

      if (!cfg) return {};

      // Intentar deserializar mientras siga siendo string JSON
      while (typeof cfg === 'string') {
        cfg = JSON.parse(cfg);
      }

      return cfg && typeof cfg === 'object' ? cfg : {};
    } catch (error) {
      return {};
    }
  };

  // ── 3. Obtener contexto del cliente según API ─────────────
  let previous_response_id = null;
  let id_thread = null;
  let headers_assistants = null;

  if (USAR_RESPONSES_API) {
    previous_response_id = await obtenerUltimoResponseId(id_cliente);
    await log(
      previous_response_id
        ? `🔗 Encadenando con previous_response_id=${previous_response_id}`
        : `🆕 Primer mensaje del cliente, sin previous_response_id`,
    );
  } else {
    const {
      obtenerOCrearThreadId,
    } = require('../services/obtener_thread.service');
    id_thread = await obtenerOCrearThreadId(id_cliente, api_key_openai);
    if (!id_thread) {
      await log(`⚠️ No se pudo obtener thread para id_cliente=${id_cliente}`);
      return { ok: false, motivo: 'sin_thread' };
    }
    headers_assistants = {
      Authorization: `Bearer ${api_key_openai}`,
      'Content-Type': 'application/json',
      'OpenAI-Beta': 'assistants=v2',
    };
    await log(`🧵 Thread obtenido: ${id_thread}`);
  }

  let bloqueContexto = '';
  let total_tokens = 0;
  /* Una ubicación compartida por WhatsApp se guarda como el JSON crudo que
     manda Meta (`{"latitude":-0.3,"longitude":-78.4}`) porque así lo pinta el
     chat. Al asistente le llegaba eso literal y contestaba lo que se puede
     esperar de alguien que recibe un JSON: pedía la dirección "en palabras".
     Y en captación —donde al propietario se le PIDE que mande la ubicación—
     eso es quedarse sin el dato justo después de conseguirlo.
     Se traduce solo para el modelo; lo guardado no se toca. */
  const textoDelSistema =
    textoDeUbicacion(mensaje) || textoDeMensajeIlegible(mensaje);

  let mensajeFinal = textoDelSistema || mensaje;

  /* Para elegir qué productos se le inyectan solo cuentan las palabras del
     CLIENTE. Cuando el texto lo escribió el sistema —el relleno de un mensaje
     ilegible, o la traducción de una ubicación— no se nombró ningún producto, y
     buscar sobre ese texto ata cosas al azar: primero fue "tipo" contra "Cable
     Tipo C", y después mi propia instrucción, que también habla de productos.
     Va vacío: la lista de precios se sigue entregando, la ficha no. */
  const mensajeParaBuscar = textoDelSistema ? '' : mensaje;

  // ── 4. ACCIÓN: separador_productos (pre-procesamiento) ────
  /* if (tieneAccion('separador_productos')) {
    const [acSep] = getAcciones('separador_productos');
    const cfg = parseConfig(acSep);
    const sep_asst = cfg.assistant_id || null;

    if (sep_asst) {
      try {
        const sepResult = await ejecutarAsistente({
          id_thread,
          assistant_id: sep_asst,
          mensaje,
          max_tokens: 100,
          headers,
        });
        if (sepResult.respuesta) {
          bloqueContexto += `📦 Productos mencionados en el mensaje:\n${sepResult.respuesta}\n\n`;
          total_tokens += sepResult.total_tokens;
          await log(`✅ Separador productos: ${sepResult.respuesta}`);
        }
      } catch (err) {
        await log(`⚠️ Error separador_productos: ${err.message}`);
      }
    }
  } */

  // ── 5. ACCIÓN: contexto_productos ─────────────────────────
  if (tieneAccion('contexto_productos') && bloqueContexto) {
    // El catálogo ya está en el vector_store del asistente (file_search).
    // Aquí solo inyectamos el bloque del separador como mensaje de contexto.
    // Si no hay separador, el file_search del asistente ya tiene el catálogo completo.
    await log(
      `ℹ️ contexto_productos activo — catálogo en vector_store="${columna.vector_store_id}"`,
    );
  }

  // ── 6. ACCIONES: contexto_establecimientos + contexto_calendario ──
  // Lo arma construirContextoColumna(), compartido con el chat de prueba para
  // que la prueba responda con la misma información que producción.
  bloqueContexto += await construirContextoColumna(
    id_configuracion,
    acciones,
    log,
    /* Va `mensajeFinal` y NO el crudo, a propósito. El contexto tiene que
       armarse con el MISMO texto que va a leer el modelo: acá se decide qué
       productos se le inyectan, y con el texto crudo se decidía sobre relleno
       del sistema. Un "Tipo de mensaje no reconocido." hacía coincidir la
       palabra "tipo" con "Cable Tipo C 240W" y el bot recibía la ficha de ese
       producto bajo el título "lo que la persona nombró". Después ofrecía el
       cable a alguien que solo había mandado un sticker.

       El id_cliente es para entregarle el teléfono desde el que escribe en vez
       de que se lo pregunte. */
    { mensaje: mensajeParaBuscar, id_cliente },
  );

  // ── 6.5 Columna principal Dropi: inyectar la orden ya existente ──
  // La plantilla de confirmación se envió por fuera del thread, así que el
  // asistente no la ve. Le pasamos los datos reales de la orden (del cache)
  // para que confirme/edite sin inventar y pueda responder "¿qué dirección
  // tengo?".
  if (columna.es_dropi_principal) {
    try {
      const tel9 = String(telefono || '')
        .replace(/\D/g, '')
        .slice(-9);
      if (tel9.length >= 9) {
        const [ord] = await db.query(
          `SELECT name, surname, phone, city, provincia, total_order,
                  product_names, order_data
             FROM dropi_orders_cache
            WHERE id_configuracion = ?
              AND RIGHT(REGEXP_REPLACE(phone, '[^0-9]', ''), 9) = ?
              AND UPPER(status) = 'PENDIENTE CONFIRMACION'
            ORDER BY order_created_at DESC LIMIT 1`,
          {
            replacements: [id_configuracion, tel9],
            type: db.QueryTypes.SELECT,
          },
        );
        if (ord) {
          let dir = '';
          try {
            dir = JSON.parse(ord.order_data || '{}').dir || '';
          } catch (_) {}
          let prod = ord.product_names || '';
          try {
            const a = JSON.parse(ord.product_names || '[]');
            if (Array.isArray(a)) prod = a.join(', ');
          } catch (_) {}
          bloqueContexto +=
            `📦 Pedido del cliente (ya registrado, en Pendiente confirmación):\n` +
            `- Nombre: ${[ord.name, ord.surname].filter(Boolean).join(' ')}\n` +
            `- Teléfono: ${ord.phone || ''}\n` +
            `- Ciudad: ${ord.city || ''}\n` +
            `- Provincia: ${ord.provincia || ''}\n` +
            `- Dirección: ${dir}\n` +
            `- Producto: ${prod}\n` +
            `- Valor a pagar: ${ord.total_order || ''}\n\n`;
          await log(`📦 Contexto orden Dropi inyectado cliente=${id_cliente}`);
        } else {
          await log(
            `ℹ️ Sin orden PENDIENTE CONFIRMACION en cache cliente=${id_cliente}`,
          );
        }
      }
    } catch (e) {
      await log(`⚠️ Error inyectando contexto orden Dropi: ${e.message}`);
    }
  }

  // ── 7. Construir input / enviar al thread ─────────────────
  let inputFinal = mensajeFinal;

  if (USAR_RESPONSES_API) {
    if (bloqueContexto.trim()) {
      inputFinal = `🧾 Contexto adicional:\n\n${bloqueContexto.trim()}\n\n${mensajeFinal}`;
    }

    // ── Siembra del contexto cuando no hay cadena ─────────────
    //
    // Sin previous_response_id el modelo arranca en blanco: no sabe que ya
    // habló con esta persona, la saluda de nuevo y le vuelve a pedir datos que
    // ya dio. Eso pasa en dos situaciones, y las dos importan:
    //
    //   1. La cuenta acaba de pasar de la Assistants API a Responses. Todo su
    //      historial estaba en threads de OpenAI y la cadena nueva empieza
    //      vacía. Con la migración de las 273 configuraciones antes del
    //      2026-08-26 (OpenAI apaga Assistants), son ~76.000 clientes a mitad
    //      de conversación.
    //   2. obtenerUltimoResponseId() borra la cadena tras 14 días de silencio.
    //      Ese caso YA existía y nadie lo estaba tapando: el cliente vuelve y
    //      el bot no lo conoce.
    //
    // La cura es la misma para las dos: rearmar la conversación desde
    // mensajes_clientes, que es donde de verdad vive el historial —los threads
    // de OpenAI eran una copia. Es exactamente lo que ya se hace al reventar el
    // contexto, un turno antes.
    //
    // Se paga UNA vez: OpenAI guarda esta respuesta (store: true) y a partir
    // del mensaje siguiente la cadena viaja por previous_response_id. Medido:
    // ~456 tokens por conversación.
    if (!previous_response_id && !usaRecapConversacion(id_configuracion)) {
      // Cuenta en CONFIGS_SIN_RECAP: arranca en blanco a propósito. Ni siquiera
      // se consulta la BD —no tiene sentido armar un recap para descartarlo—.
      // Ver el porqué de cada cuenta en utils/openia/responsesApi.js.
      await log(
        `🚫 Siembra desactivada para config=${id_configuracion} ` +
          `(CONFIGS_SIN_RECAP): arranca en blanco cliente=${id_cliente}`,
      );
    } else if (!previous_response_id) {
      const recap = await construirRecapConversacion(id_cliente);

      // Con un solo mensaje no hay nada que retomar: es el que acaba de llegar,
      // que el webhook ya guardó antes de llamarnos, así que sembrar sería
      // repetirle al modelo lo que ya tiene en el input.
      //
      // Se cuentan MENSAJES, no líneas: el recap une los textos con \n y un
      // cliente nuevo que escriba un mensaje de varias líneas daría más de una
      // sin tener historial. Cada mensaje empieza con "Cliente: " o
      // "Asistente: " a principio de línea.
      const nMensajes = (recap.match(/^(Cliente|Asistente): /gm) || []).length;

      if (nMensajes >= 2) {
        inputFinal = `[CONTEXTO DE LA CONVERSACIÓN PREVIA — retómala, NO saludes de nuevo ni pidas datos ya dados]\n${recap}\n\n[MENSAJE ACTUAL DEL CLIENTE]\n${inputFinal}`;
        await log(
          `🌱 Sin cadena previa: sembrado con recap (${nMensajes} mensajes, ` +
            `${recap.length} chars) cliente=${id_cliente}`,
        );
      } else {
        await log(
          `🆕 Sin cadena previa y sin historial (${nMensajes} mensajes): arranca limpio cliente=${id_cliente}`,
        );
      }
    }
  } else {
    if (bloqueContexto.trim()) {
      await axios
        .post(
          `https://api.openai.com/v1/threads/${id_thread}/messages`,
          {
            role: 'user',
            content: `🧾 Contexto adicional:\n\n${bloqueContexto.trim()}`,
          },
          { headers: headers_assistants },
        )
        .catch(async (err) =>
          log(`⚠️ Error enviando contexto: ${err.message}`),
        );
    }
    await axios
      .post(
        `https://api.openai.com/v1/threads/${id_thread}/messages`,
        { role: 'user', content: mensajeFinal },
        { headers: headers_assistants },
      )
      .catch(async (err) => log(`⚠️ Error enviando mensaje: ${err.message}`));
  }

  // ── Producto del anuncio: blindar precio en TODOS los turnos ──
  // Si el webhook ya mandó el bloque (primer mensaje del click), se usa.
  // Si no vino (mensajes siguientes), se reconstruye desde ultimo_producto_ad.
  let instruccionesProducto = bloque_producto_referral || null;

  /* if (
    !instruccionesProducto &&
    (id_configuracion == 10 ||
      id_configuracion == 277 ||
      id_configuracion == 392 ||
      id_configuracion == 569 ||
      id_configuracion == 360 ||
      id_configuracion == 324 ||
      id_configuracion == 476)
  ) { */
  const [cli] = await db.query(
    `SELECT ultimo_producto_ad FROM clientes_chat_center WHERE id = ? LIMIT 1`,
    { replacements: [id_cliente], type: db.QueryTypes.SELECT },
  );
  const ultimoProductoAd = (cli?.ultimo_producto_ad || '').trim();

  if (ultimoProductoAd) {
    const {
      buscarProductoPorReferral,
    } = require('../utils/webhook_whatsapp/buscar_producto_referral');

    const bloqueProd = await buscarProductoPorReferral(
      id_configuracion,
      ultimoProductoAd,
    );

    if (bloqueProd) {
      instruccionesProducto = `[CONTEXTO: el cliente llegó por un anuncio del producto "${ultimoProductoAd}"]

          ${bloqueProd}

          INSTRUCCIÓN: Usa SOLO estos precios y URLs para este producto. Si el cliente pregunta por CUALQUIER OTRO producto distinto, usa tu catálogo (file_search) normalmente.`;
      await log(
        `📎 Producto reinyectado desde ultimo_producto_ad="${ultimoProductoAd}"`,
      );
    }
  }

  // ── 8.5 Catálogo: inline vs file_search ───────────────────
  // file_search trocea el catálogo en fragmentos de 800 tokens con 400 de
  // solapamiento y por defecto devuelve hasta 20, así que termina inyectando el
  // catálogo entero DUPLICADO. Medido en config 10: 16.230 tokens por llamada,
  // contra 2.221 del mismo catálogo en texto plano.
  //
  // Por eso, si el catálogo en texto cabe holgadamente se manda inline: sale
  // más barato Y el modelo ve el catálogo COMPLETO, sin depender de que la
  // búsqueda semántica acierte —que es de donde salen las confusiones de
  // precios entre productos, porque los cortes de 800 tokens caen en medio de
  // los items y un fragmento puede traer la cola de uno y la cabeza del otro.
  //
  // Esta decisión vive FUERA del if de la API a propósito. Estuvo adentro de la
  // rama de Responses mientras el inline era solo de la config 10, y eso hacía
  // que "activar el inline" para el resto no hiciera nada: las otras cuentas
  // pasan por ejecutarAsistente y nunca veían este bloque.
  const catalogoInline = (columna.catalogo_inline || '').trim();
  const inlineTokens = Number(columna.catalogo_inline_tokens || 0);
  const usarInline =
    !!catalogoInline && catalogoInlineActivo(id_configuracion, inlineTokens);

  if (usarInline) {
    await log(`📄 Catálogo INLINE (${inlineTokens} tokens) — sin file_search`);
  } else if (columna.vector_store_id) {
    // Se distingue POR QUÉ no fue inline. Sin esto, una cuenta habilitada que
    // se pasa del tope y una que nunca se habilitó dan el mismo log, y no hay
    // manera de comprobar desde afuera que el tope está haciendo su trabajo.
    const motivo = !usaCatalogoInline(id_configuracion)
      ? 'cuenta no habilitada'
      : !catalogoInline
        ? 'sin catálogo inline guardado todavía'
        : `NO CABE: ${inlineTokens} tokens > tope ${TOPE_CATALOGO_INLINE}`;
    await log(`🔎 Catálogo por file_search (${motivo})`);
  }

  // El mismo texto sirve para las dos APIs; cambia solo por dónde entra:
  //   Responses  → `instructions`
  //   Assistants → `additional_instructions` del run
  // Las dos se reenvían enteras en cada llamada y ninguna queda guardada en la
  // conversación, así que el costo es PLANO. Es justo lo contrario de
  // file_search, cuyos fragmentos sí quedan pegados —en el thread o en la
  // cadena de previous_response_id— y se re-cobran en todos los turnos
  // siguientes: 16.000 tokens en el turno 1, 32.000 en el 2, 48.000 en el 3.
  // Por eso el inline gana desde el segundo turno aunque de entrada parezca
  // más caro.
  //
  // El puente va ANTES del catálogo, no al final: así el modelo lee la
  // aclaración justo antes del bloque al que apunta.
  const bloqueCatalogo = usarInline
    ? `${PUENTE_INLINE}\n\n${catalogoInline}`
    : null;

  // ── 9. Ejecutar ───────────────────────────────────────────
  let resultado;
  try {
    if (USAR_RESPONSES_API) {
      await log(`🚨 entro sin polling NUEVO SISTEMA`);

      const instruccionesFinales = bloqueCatalogo
        ? `${assistantInfo.instructions}\n\n${bloqueCatalogo}`
        : assistantInfo.instructions;

      resultado = await ejecutarConResponsesAPI({
        previous_response_id,
        instructions: instruccionesFinales,
        additional_instructions: instruccionesProducto || null,
        input: inputFinal,
        model: assistantInfo.model,
        max_tokens: columna.max_tokens || 500,
        // El catálogo se apaga cuando va inline; los documentos NO, porque no
        // tienen otra vía de llegar al modelo.
        vector_store_id: usarInline ? null : columna.vector_store_id || null,
        vector_store_docs_id: columna.vector_store_docs_id || null,
        api_key_openai,
        id_configuracion,
      });
    } else {
      await log(`🚨 entro con polling VIEJO SISTEMA`);

      // Acá el prompt vive en el assistant de OpenAI, no en la BD, así que el
      // catálogo no se puede concatenar a `instructions`: entra por
      // `additional_instructions`, que la API aplica SOLO a este run y no
      // guarda en el thread. Mismo costo plano que el inline por Responses.
      //
      // El bloque del producto del anuncio va DESPUÉS del catálogo a propósito:
      // si se contradicen, lo específico tiene que ganarle a lo general.
      const additional =
        [bloqueCatalogo, instruccionesProducto].filter(Boolean).join('\n\n') ||
        null;

      resultado = await ejecutarAsistente({
        id_thread,
        assistant_id: columna.assistant_id,
        mensaje: null,
        max_tokens: columna.max_tokens || 500,
        headers: headers_assistants,
        skip_send_message: true,
        additional_instructions: additional,
      });
    }
  } catch (err) {
    if (esSinSaldo(err) || err.code === 'sin_saldo_openai') {
      await log(`🚨 SIN SALDO OPENAI para config=${id_configuracion}`);
      await marcarOpenAIInactivo(
        id_configuracion,
        err.motivoOpenAI || mensajeErrorOpenAI(err) || 'Sin saldo OpenAI',
      );
      return { ok: false, motivo: 'sin_saldo_openai' };
    }

    // Contexto excedido (solo Responses API): reintentar UNA vez SIN encadenar,
    // pero RE-SEMBRANDO el hilo con un resumen de la conversación (desde nuestra
    // BD) para no perder el producto ni los datos del cliente. Se auto-cura.
    if (USAR_RESPONSES_API && previous_response_id && esContextoExcedido(err)) {
      const recap = await construirRecapConversacion(id_cliente);
      await log(
        `♻️ context_length_exceeded — reset de hilo con recap (${recap.length} chars) cliente=${id_cliente}`,
      );

      const inputConRecap = recap
        ? `[CONTEXTO DE LA CONVERSACIÓN PREVIA — retómala, NO saludes de nuevo ni pidas datos ya dados]\n${recap}\n\n[MENSAJE ACTUAL DEL CLIENTE]\n${inputFinal}`
        : inputFinal;

      try {
        resultado = await ejecutarConResponsesAPI({
          previous_response_id: null,
          // Mismo criterio que el intento original. Antes esta rama mandaba las
          // instrucciones peladas y volvía a prender file_search, o sea que el
          // reintento de un desborde de contexto reinyectaba los ~16.000 tokens
          // de fragmentos que lo habían provocado.
          instructions: bloqueCatalogo
            ? `${assistantInfo.instructions}\n\n${bloqueCatalogo}`
            : assistantInfo.instructions,
          additional_instructions: instruccionesProducto || null,
          input: inputConRecap,
          model: assistantInfo.model,
          max_tokens: columna.max_tokens || 500,
          vector_store_id: usarInline ? null : columna.vector_store_id || null,
          vector_store_docs_id: columna.vector_store_docs_id || null,
          api_key_openai,
          id_configuracion,
        });
      } catch (err2) {
        if (esSinSaldo(err2)) {
          await marcarOpenAIInactivo(
            id_configuracion,
            mensajeErrorOpenAI(err2) || 'Sin saldo OpenAI',
          );
          return { ok: false, motivo: 'sin_saldo_openai' };
        }
        await log(`❌ Error tras reset de hilo: ${err2.message}`);
        throw err2;
      }
    } else {
      /* El detalle que manda OpenAI, no solo el código.
         "Request failed with status code 429" no se puede diagnosticar: puede
         ser el límite por minuto del modelo o la cuenta sin saldo, y son cosas
         distintas con arreglos distintos. El body lo dice —incluye el límite y
         cuánto falta para que se libere— y estaba en el error, sin registrarse:
         para saberlo había que reproducirlo a mano contra la API. */
      const detalle = err.response?.data?.error;
      await log(
        `❌ Error ejecutando asistente: ${err.message}` +
          (detalle
            ? ` · OpenAI: ${detalle.message}` +
              (detalle.code ? ` [${detalle.code}]` : '')
            : ''),
      );
      throw err;
    }
  }

  if (!resultado || !resultado.respuesta) {
    await log(`⚠️ Asistente sin respuesta para columna="${columna.nombre}"`);
    return { ok: false, motivo: 'sin_respuesta_asistente' };
  }

  // Guardar contexto según API
  if (USAR_RESPONSES_API) {
    await guardarResponseId(id_cliente, resultado.response_id);
    await log(`💾 response_id guardado: ${resultado.response_id}`);
  }

  total_tokens += resultado.total_tokens;
  const respuestaCruda = resultado.respuesta;
  const respuestaRaw = sanitizarRespuestaAgente(respuestaCruda);

  // Log solo si el sanitizador modificó algo
  if (respuestaCruda !== respuestaRaw) {
    await log(
      `🧹 Sanitizador aplicado. Antes: ${respuestaCruda.slice(0, 200)}`,
    );
    await log(`🧹 Después: ${respuestaRaw.slice(0, 200)}`);
  }

  /* await log(
    `✅ Respuesta asistente columna="${columna.nombre}": ${respuestaRaw.slice(0, 120)}...`,
  ); */

  await log(
    `✅ Respuesta asistente columna="${columna.nombre}" (FULL):\n----INICIO----\n${respuestaRaw}\n----FIN----`,
  );

  await log(`🧪 Acciones cargadas: ${JSON.stringify(acciones)}`);
  await log(
    `🧪 Acciones cambiar_estado: ${JSON.stringify(getAcciones('cambiar_estado'))}`,
  );

  /* ── 9.8 Prometió una cita sin poder crearla ───────────────
     La columna de entrada NO tiene la agenda: su prompt le prohíbe confirmar y
     le pide pasar la ficha a la etapa que sí reserva. Aun así, a veces escribe
     "te agendo la consulta para el lunes a las 10" y no emite ningún tag: la
     ficha se queda quieta, la cita no existe y el paciente cree que tiene hora.
     En un consultorio eso significa alguien presentándose con un problema de
     salud sin estar en ninguna lista.

     Si el mensaje suena a confirmación y la columna sabe derivar a la etapa que
     agenda, se deriva igual. No deshace la promesa —eso lo arregla una persona o
     el siguiente mensaje— pero al menos la conversación queda en manos de quien
     sí puede reservar. */
  const accionAgenda = getAcciones('cambiar_estado')
    .map((ac) => parseConfig(ac))
    .find((c) => c.estado_destino === 'califica');

  if (
    accionAgenda &&
    !tieneAccion('agendar_cita') &&
    !respuestaRaw.includes(accionAgenda.trigger)
  ) {
    /* Formas escritas una por una en vez de prefijo + terminación: con el
       patrón corto, "te paso con LA AGENDA" —que es el comportamiento correcto—
       daba positivo. Y hay que cubrir presente y futuro, porque el modelo
       alterna entre "te agendo" y "te agendaré". */
    /* El cierre es un lookahead y no `\b`: en JavaScript `\b` se calcula con
       [A-Za-z0-9_], así que una palabra terminada en acento —"agendaré"— no
       tiene frontera de palabra al final y el patrón no cerraba nunca. */
    const finPalabra = '(?![a-záéíóúñ])';
    const PROMETE_CITA = new RegExp(
      [
        '\\b(te|le)\\s+(agendo|agendamos|agendar[eé]|agendaremos|agendar[ií]a',
        '|reservo|reservamos|reservar[eé]|confirmo|confirmamos|confirmar[eé]',
        `|separo|separamos|separar[eé])${finPalabra}`,
        '|\\b(cita|consulta|hora)\\s+(ya\\s+)?(qued[oó]|queda|est[aá])\\s+',
        `(agendad[ao]|reservad[ao]|confirmad[ao])${finPalabra}`,
        // Pronombre pegado al verbo: "voy a agendarte", "puedo reservarle".
        `|\\b(agendar|reservar|confirmar|separar)(te|le|lo|la)${finPalabra}`,
      ].join(''),
      'i',
    );

    if (PROMETE_CITA.test(respuestaRaw)) {
      await db.query(
        `UPDATE clientes_chat_center SET estado_contacto = ? WHERE id = ?`,
        {
          replacements: [accionAgenda.estado_destino, id_cliente],
          type: db.QueryTypes.UPDATE,
        },
      );
      await log(
        `⚠️ "${columna.nombre}" confirmó una cita que no puede crear y no marcó el tag: cliente ${id_cliente} derivado a "${accionAgenda.estado_destino}"`,
      );
    }
  }

  /* ── 9.9 Quien pregunta por un PRODUCTO va a su columna ────
     Enrutar no puede depender de que el modelo se acuerde de escribir un tag.
     Medido en la 818: ante "quiero comprar la máquina cortadora", el asistente
     de contacto inicial unas veces no marcaba nada y otras contestaba "te paso
     con la agenda" —mandándolo a agendar una cita para comprar un aparato—.

     Un producto del catálogo nombrado en el mensaje, con intención de compra,
     es una señal que el código puede leer solo. La columna destino tiene que
     existir y estar configurada en el tablero, así que esto no se activa en
     cuentas que no venden productos. */
  const accionProducto = getAcciones('cambiar_estado')
    .map((ac) => parseConfig(ac))
    .find((c) => c.estado_destino === 'venta_producto');

  if (accionProducto && !respuestaRaw.includes('[venta_producto]:true')) {
    const RE_COMPRA =
      /\b(compr|quiero la|quiero el|me la llevo|me lo llevo|cu[aá]nto (cuesta|vale|sale)|precio|venden|tienen|c[oó]mo la consigo)/i;

    if (RE_COMPRA.test(mensaje)) {
      const productos = await db.query(
        `SELECT nombre FROM productos_chat_center
          WHERE id_configuracion = ? AND eliminado = 0
            AND LOWER(COALESCE(tipo, '')) NOT LIKE 'servicio%'`,
        { replacements: [id_configuracion], type: db.QueryTypes.SELECT },
      );

      const norm = (s) =>
        String(s || '')
          .toLowerCase()
          .normalize('NFD')
          .replace(/\p{M}/gu, '')
          .replace(/[^a-z0-9\s]/g, ' ')
          .replace(/\s+/g, ' ')
          .trim();

      const palabras = norm(mensaje)
        .split(' ')
        .filter((p) => p.length > 3);

      /* Se pide que coincidan DOS palabras del nombre, no una: "profesional" o
         "facial" sueltas aparecen en medio catálogo y mandarían a la columna
         equivocada a quien pregunta por un tratamiento. */
      const nombrado = productos.find((p) => {
        const tokens = norm(p.nombre)
          .split(' ')
          .filter((t) => t.length > 3);
        const aciertos = tokens.filter((t) => palabras.includes(t)).length;
        return aciertos >= Math.min(2, tokens.length);
      });

      if (nombrado) {
        await db.query(
          `UPDATE clientes_chat_center SET estado_contacto = 'venta_producto'
            WHERE id = ?`,
          { replacements: [id_cliente], type: db.QueryTypes.UPDATE },
        );
        await log(
          `🛍️ "${nombrado.nombre}" es un producto y el mensaje muestra intención de compra: cliente ${id_cliente} movido a "venta_producto" sin depender del tag`,
        );
      }
    }
  }

  // ── 10. ACCIÓN: cambiar_estado ────────────────────────────
  // ¿Esta respuesta cierra la venta (resumen del pedido)? Lo decide el paso 10
  // y lo usa el 13 para no repetir el resumen. Se declara afuera del bucle.
  let cerroLaVenta = false;
  /* Cierre con resumen basura: se bloquea y el paso 12 reemplaza la respuesta
     por la petición de datos. Ver motivoCierreInvalido. */
  let cierreBloqueado = null;
  const claveResumen = `${id_configuracion}|${id_cliente}`;
  for (const ac of getAcciones('cambiar_estado')) {
    const cfg = parseConfig(ac);
    const trigger = cfg.trigger || '';
    const estadoDestino = cfg.estado_destino || '';
    if (!trigger || !estadoDestino) continue;

    const coincide = respuestaRaw.toLowerCase().includes(trigger.toLowerCase());
    if (coincide) {
      /* ── Validación del cierre de venta ──
         Caso real (285, 2026-08-17, cliente Vinicio): el cliente dijo "Si el
         combo de tres" sin haber dado ni un dato, y el modelo —con el hilo
         perdido— copió la PLANTILLA del prompt tal cual: "🧑 Nombre: *[nombre
         completo real]* 📞 Telefono: *[teléfono real y completo]*…", cerró con
         "Gracias por tu compra" y el trigger movió el contacto a generar_guia.
         Un asesor tuvo que entrar a pedir los datos a mano.

         El arnés de prompts ya cazaba esto EN LAS PRUEBAS ("usó placeholders
         en un resumen"), pero en runtime nadie miraba: el trigger movía la
         columna con lo que fuera. Cerrar una venta es un acto con consecuencias
         (columna + auto-orden en Dropi): solo vale con datos de verdad. */
      if (estadoDestino === 'generar_guia') {
        const motivo = motivoCierreInvalido(respuestaRaw);
        if (motivo) {
          cierreBloqueado = motivo;
          await log(
            `🚫 Cierre de venta BLOQUEADO (${motivo}): ni cambio de columna ni ` +
              `auto-orden. Se le piden los datos al cliente.`,
          );
          continue;
        }
      }
      // Esta respuesta ES un cierre de venta. Se marca para que el paso 13 no
      // mande el mismo resumen dos veces cuando el cliente escribió en ráfaga.
      if (estadoDestino === 'generar_guia') cerroLaVenta = true;
      await db.query(
        `UPDATE clientes_chat_center SET estado_contacto = ? WHERE id = ?`,
        {
          replacements: [estadoDestino, id_cliente],
          type: db.QueryTypes.UPDATE,
        },
      );
      await log(
        `🔄 Estado cambiado a "${estadoDestino}" (trigger="${trigger}")`,
      );

      //  Auto-orden Dropi: el trigger movió al cliente a generar_guia.
      // Se extraen los datos del resumen del bot con regex (emoji opcional);
      // si faltan campos, dropiAutoOrder.service los completa con un
      // extractor IA sobre la conversación (usa la api_key del cliente).
      // Cualquier resultado queda en dropi_auto_ordenes_log.
      // Ruta según origen: si el cliente confirma desde la columna principal
      // de Dropi (pendiente_confirmacion), la orden YA existe → se ACTUALIZA a
      // PENDIENTE; en cualquier otra columna (contacto_inicial) se CREA nueva.
      if (estadoDestino === 'generar_guia') {
        try {
          const g = (re) => respuestaRaw.match(re)?.[1]?.trim() || '';
          const datosBot = {
            nombre: g(/🧑?\s*Nombre:\s*(.+)/i),
            telefono: g(/📞?\s*Tel[eé]fono:\s*(.+)/i) || telefono,
            // Acepta el término regional según el país (provincia EC/PA,
            // departamento CO/PE/GT, estado MX, región CL).
            provincia: g(
              /📍?\s*(?:Provincia|Departamento|Depto\.?|Estado|Regi[oó]n):\s*(.+)/i,
            ),
            ciudad: g(/📍?\s*Ciudad:\s*(.+)/i),
            direccion: g(/🏡?\s*Direcci[oó]n:\s*(.+)/i),
            producto: g(/📦?\s*Producto:\s*(.+)/i),
            precio: g(/💰?\s*Precio total:\s*(.+)/i),
            cantidad: g(/🔢?\s*Cantidad:\s*(.+)/i) || '',
            // Modalidad de envío (opcional): "domicilio" o "agencia
            // servientrega". Si el bot la incluye, el auto-orden fuerza
            // Servientrega cuando es agencia.
            modalidad_envio:
              g(/🚚?\s*Env[ií]o:\s*(.+)/i) ||
              g(/📦?\s*Modalidad:\s*(.+)/i) ||
              '',
            // Variedad elegida en productos variables (talla/color). Sin esto
            // el auto-orden no sabe qué variante subir y Dropi rechaza la
            // orden. Se aceptan varios rótulos porque el prompt de cada
            // cliente los escribe distinto.
            variedad:
              g(/🎨?\s*Variedad:\s*(.+)/i) ||
              g(/🎨?\s*Variante:\s*(.+)/i) ||
              g(/🎨?\s*Color:\s*(.+)/i) ||
              g(/📏?\s*Talla:\s*(.+)/i) ||
              '',
          };

          // Datos que el cliente pudo corregir (para el flujo de actualizar).
          const cambios = {
            nombre: g(/🧑?\s*Nombre:\s*(.+)/i),
            telefono: g(/📞?\s*Tel[eé]fono:\s*(.+)/i),
            ciudad: g(/📍?\s*Ciudad:\s*(.+)/i),
            direccion: g(/🏡?\s*Direcci[oó]n:\s*(.+)/i),
          };

          /* ── Candado anti-duplicado ──
             Cuando el cliente manda dos mensajes seguidos, cada uno corre su
             propio turno de IA (no hay agrupación de ráfagas) y el asistente
             cierra la venta en las DOS respuestas: dos resúmenes, dos tags, dos
             órdenes en Dropi con segundos de diferencia. Le pasó 6 veces a la
             cfg 411 —separaciones de 2 a 193 segundos— y el cliente lo vio como
             pedidos duplicados en /pedidos.

             El reclamo es síncrono (utils/dedupeAutoOrden.js), así que de dos
             corridas simultáneas solo una entra. Si la que entró NO termina
             creando —producto sin match, ciudad sin cod_dane, gate apagado—, se
             suelta enseguida para que el próximo mensaje pueda reintentar; el
             comportamiento de los pedidos que hoy caen a manual no cambia. */
          const claveAutoOrden = `${id_configuracion}|${id_cliente}`;
          const dispararAutoOrden = ({ force }) => {
            autoCrearOrdenDropi({
              id_configuracion,
              id_cliente,
              api_key_openai,
              datosBot,
              force,
              dedupe: true,
            })
              .then((r) => {
                if (r?.orderId) confirmarAutoOrden(claveAutoOrden);
                else liberarAutoOrden(claveAutoOrden);
              })
              .catch(() => liberarAutoOrden(claveAutoOrden));
          };

          // MODELO PER-COLUMNA (full pro): la acción Dropi de la columna decide
          // qué hacer y su `activo` es el gate. Si la columna no tiene ninguna
          // acción Dropi → FALLBACK al modelo viejo (flag config + es_dropi_principal),
          // para no romper configs no migradas.
          const dropiAcc = await db.query(
            `SELECT tipo_accion, activo FROM kanban_acciones
             WHERE id_kanban_columna = ?
               AND tipo_accion IN ('crear_orden_dropi','actualizar_orden_dropi')
             ORDER BY id DESC LIMIT 1`,
            { replacements: [columna.id], type: db.QueryTypes.SELECT },
          );
          const acc = dropiAcc[0];

          if (acc) {
            // Nuevo modelo: la acción es el gate (force salta el flag config).
            if (Number(acc.activo) === 1) {
              if (acc.tipo_accion === 'actualizar_orden_dropi') {
                autoActualizarOrdenDropi({
                  id_configuracion,
                  id_cliente,
                  telefono,
                  cambios,
                  force: true,
                }).catch(() => {});
                await log(
                  `🔁 Actualizar orden Dropi (acción columna) cliente=${id_cliente}`,
                );
              } else if (reclamarAutoOrden(claveAutoOrden)) {
                dispararAutoOrden({ force: true });
                await log(
                  `🛒 Crear orden Dropi (acción columna) cliente=${id_cliente}`,
                );
              } else {
                await log(
                  `🚫 Auto-orden Dropi OMITIDA (acción columna) cliente=${id_cliente}: ya hay una creación en curso o recién hecha para este cliente`,
                );
              }
            } else {
              await log(
                `⏸️ Acción Dropi apagada en la columna, sin acción cliente=${id_cliente}`,
              );
            }
          } else if (columna.es_dropi_principal) {
            // Fallback viejo: columna principal Dropi → actualizar (gate: flag).
            autoActualizarOrdenDropi({
              id_configuracion,
              id_cliente,
              telefono,
              cambios,
            }).catch(() => {});
            await log(
              `🔁 Actualización orden Dropi (fallback flag) cliente=${id_cliente}`,
            );
          } else if (reclamarAutoOrden(claveAutoOrden)) {
            // Fallback viejo: cualquier otra columna → crear (gate: flag).
            dispararAutoOrden({ force: false });
            await log(
              `🛒 Auto-orden Dropi (fallback flag) cliente=${id_cliente}`,
            );
          } else {
            await log(
              `🚫 Auto-orden Dropi OMITIDA (fallback flag) cliente=${id_cliente}: ya hay una creación en curso o recién hecha para este cliente`,
            );
          }
        } catch (e) {
          await log(`⚠️ Error disparando auto-orden: ${e.message}`);
        }
      }
      // No break — puede haber múltiples cambios de estado (poco común pero posible)
    }
  }

  // ── 11. ACCIÓN: agendar_cita ──────────────────────────────
  // Se declara afuera porque el control de "conversación que no avanza" (11.5)
  // también lo mira: escribir el bloque ES avanzar, aunque falte el tag.
  let escribioBloqueCita = false;

  if (tieneAccion('agendar_cita')) {
    const [acCita] = getAcciones('agendar_cita');
    const cfg = parseConfig(acCita);
    const trigger = cfg.trigger || '[cita_confirmada]: true';

    /* El tag es la señal, pero no se puede depender solo de él: el modelo
       escribe el bloque completo, le dice al cliente "tu cita quedó agendada" y
       a veces se olvida de la última línea. Ahí no se creaba nada, la tarjeta se
       quedaba quieta y nadie se enteraba hasta que la persona llegaba al local.
       Si el bloque está entero —con fecha de inicio y de fin— se agenda igual:
       el bloque ES la confirmación. */
    const escribioBloque =
      /Fecha y hora(?: de inicio)?\s*:/i.test(respuestaRaw) &&
      /Servicio que desea\s*:/i.test(respuestaRaw);
    escribioBloqueCita = escribioBloque;

    const tieneTag = respuestaRaw.toLowerCase().includes(trigger.toLowerCase());

    if (!tieneTag && escribioBloque) {
      await log(
        `⚠️ agendar_cita: el bot escribió el bloque de confirmación SIN el tag ${trigger}; se agenda igual`,
      );
    }

    if (tieneTag || escribioBloque) {
      /* Dónde se hace la cita lo decide la columna, no el código: la misma
         plantilla sirve a una clínica (se atiende en el local) y a una
         inmobiliaria (se visita el inmueble). Sin la llave configurada vale
         'sede', que es como venía funcionando. */
      const res = await procesarAgendarCita(
        respuestaRaw,
        id_configuracion,
        id_cliente,
        { lugar_cita: cfg.lugar_cita, modo: cfg.modo },
      ).catch(async (err) => {
        await log(`⚠️ Error agendar_cita: ${err.message}`);
        return { ok: false, motivo: err.message };
      });

      /* En modo solicitud la tarjeta NO puede quedarse en "cita agendada": no
         hay ninguna cita. Va a la columna de revisión, que es el único aviso
         que va a tener quien atiende de que hay alguien esperando confirmación.
         Corre después de `cambiar_estado` (paso 10) a propósito: lo que esa
         acción haya hecho se pisa acá, que es la decisión correcta. */
      if (res?.ok && res.modo === 'solicitud') {
        const destino = String(cfg.estado_solicitud || 'por_agendar').trim();
        const [colDestino] = await db.query(
          `SELECT id FROM kanban_columnas
            WHERE id_configuracion = ? AND LOWER(estado_db) = LOWER(?) AND activo = 1
            LIMIT 1`,
          {
            replacements: [id_configuracion, destino],
            type: db.QueryTypes.SELECT,
          },
        );

        if (colDestino) {
          await db.query(
            `UPDATE clientes_chat_center SET estado_contacto = ? WHERE id = ?`,
            { replacements: [destino, id_cliente], type: db.QueryTypes.UPDATE },
          );
          await log(
            `🔄 Solicitud #${res.id_solicitud}: contacto ${id_cliente} movido a "${destino}"`,
          );
        } else {
          /* Sin la columna, la solicitud existe pero nadie la ve en el tablero.
             Se avisa fuerte porque el síntoma es el peor de todos: el bot le
             dijo a la persona que le confirman el horario y no hay nada que se
             lo recuerde a nadie. */
          await log(
            `🚨 Solicitud #${res.id_solicitud} guardada pero la configuración ${id_configuracion} ` +
              `no tiene columna "${destino}": revísala en el panel de solicitudes o créala`,
          );
        }
      }

      /* Si la cita no se creó, la tarjeta NO se puede quedar en "Cita
         agendada": cambiar_estado ya corrió (paso 10) y la movió igual, así que
         quedaba una cita fantasma — visible en el tablero, inexistente en la
         agenda, y sin nada que lo delate hasta que el cliente llega al local.
         Pasa de verdad: si el horario choca con otra cita del mismo encargado,
         createAppointment responde 409 y el error se quedaba en un log.
         Va a "asesor" porque el cliente ya recibió un mensaje diciéndole que su
         cita quedó confirmada: eso lo tiene que resolver una persona. */
      /* Sin tag, `cambiar_estado` (paso 10) tampoco corrió: la cita quedaría
         creada y la tarjeta parada en la columna anterior. Se mueve acá con el
         mismo destino que tiene configurada esa acción. */
      // En modo solicitud el destino ya se decidió arriba: no se pisa.
      if (res?.ok && !tieneTag && res.modo !== 'solicitud') {
        const destino = getAcciones('cambiar_estado')
          .map((ac) => parseConfig(ac))
          .find(
            (c) =>
              String(c.trigger || '').toLowerCase() === trigger.toLowerCase(),
          )?.estado_destino;

        if (destino) {
          await db.query(
            `UPDATE clientes_chat_center SET estado_contacto = ? WHERE id = ?`,
            { replacements: [destino, id_cliente], type: db.QueryTypes.UPDATE },
          );
          await log(
            `🔄 Estado cambiado a "${destino}" por el bloque de cita (sin tag)`,
          );
        }
      }

      if (res && res.ok === false) {
        const [colAsesor] = await db.query(
          `SELECT id FROM kanban_columnas
            WHERE id_configuracion = ? AND estado_db = 'asesor' AND activo = 1
            LIMIT 1`,
          { replacements: [id_configuracion], type: db.QueryTypes.SELECT },
        );
        if (colAsesor) {
          await db.query(
            `UPDATE clientes_chat_center SET estado_contacto = 'asesor' WHERE id = ?`,
            { replacements: [id_cliente], type: db.QueryTypes.UPDATE },
          );
          await log(
            `🚨 La cita NO se creó (${res.motivo}) pero el bot ya la confirmó al cliente ${id_cliente}: movido a "asesor" para que lo resuelva una persona`,
          );
        } else {
          await log(
            `🚨 La cita NO se creó (${res.motivo}) y la configuración ${id_configuracion} no tiene columna "asesor": la tarjeta queda en "cita_agendada" sin cita real`,
          );
        }
      }
    }
  }

  /* ── 11.5 Conversación que no avanza ──────────────────────
     Una columna con IA puede dar vueltas para siempre: el bot contesta bien,
     el cliente contesta bien, y nadie escribe ningún tag. La ficha se queda
     quieta y nadie se entera hasta que alguien revisa el tablero a mano.
     Después de N respuestas seguidas sin disparar NINGUNA acción, el caso pasa
     a un asesor. No es un error del bot: es admitir que esta conversación
     necesita una persona.

     El contador se reinicia solo cuando algo avanza, así que una charla larga
     que sí progresa nunca escala. */
  const LIMITE_TURNOS_SIN_AVANCE = 10;

  const triggersColumna = acciones
    .map((ac) => parseConfig(ac).trigger)
    .filter(Boolean);

  const avanzo =
    triggersColumna.some((t) =>
      respuestaRaw.toLowerCase().includes(String(t).toLowerCase()),
    ) || escribioBloqueCita;

  if (avanzo) {
    await db.query(
      `UPDATE clientes_chat_center SET turnos_sin_avance = 0 WHERE id = ?`,
      { replacements: [id_cliente], type: db.QueryTypes.UPDATE },
    );
  } else if (triggersColumna.length) {
    const [{ turnos } = { turnos: 0 }] = await db
      .query(
        `UPDATE clientes_chat_center SET turnos_sin_avance = turnos_sin_avance + 1
        WHERE id = ?`,
        { replacements: [id_cliente], type: db.QueryTypes.UPDATE },
      )
      .then(() =>
        db.query(
          `SELECT turnos_sin_avance AS turnos FROM clientes_chat_center WHERE id = ?`,
          { replacements: [id_cliente], type: db.QueryTypes.SELECT },
        ),
      );

    if (Number(turnos) >= LIMITE_TURNOS_SIN_AVANCE) {
      const [colAsesor] = await db.query(
        `SELECT id FROM kanban_columnas
          WHERE id_configuracion = ? AND estado_db = 'asesor' AND activo = 1
          LIMIT 1`,
        { replacements: [id_configuracion], type: db.QueryTypes.SELECT },
      );

      if (colAsesor) {
        await db.query(
          `UPDATE clientes_chat_center
              SET estado_contacto = 'asesor', turnos_sin_avance = 0
            WHERE id = ?`,
          { replacements: [id_cliente], type: db.QueryTypes.UPDATE },
        );
        await log(
          `🚨 ${turnos} respuestas en "${columna.nombre}" sin que la conversación avance: cliente ${id_cliente} movido a "asesor"`,
        );
      } else {
        await log(
          `⚠️ ${turnos} respuestas sin avance en "${columna.nombre}" y la configuración ${id_configuracion} no tiene columna "asesor"`,
        );
      }
    } else if (Number(turnos) >= LIMITE_TURNOS_SIN_AVANCE - 3) {
      await log(
        `⏳ ${turnos}/${LIMITE_TURNOS_SIN_AVANCE} respuestas sin avance en "${columna.nombre}" (cliente ${id_cliente})`,
      );
    }
  }

  /* ── 11.9 La foto del producto la manda el código ──────────
     Al modelo se le entrega la imagen y la instrucción de adjuntarla, y aun así
     depende de que él decida que "es la primera vez". Con la foto cargada en el
     catálogo, que llegue o no una imagen no puede ser un criterio suyo.

     Se adjunta cuando el bot nombra un producto que tiene imagen y a ese
     contacto todavía no se la mandamos hace poco. Quién decide ese "hace poco"
     es el filtro del paso 12, que mira el historial del chat con una ventana de
     tiempo: acá solo se propone la foto. */
  let adjuntoImagen = '';

  /* La condición mira las tres etiquetas y no solo la de producto: en la
     vertical de servicios el modelo escribe `[servicio_imagen_url]`, y con el
     patrón viejo el código no se daba cuenta de que ya había una imagen en la
     respuesta, así que adjuntaba otra encima. */
  if (
    tieneAccion('contexto_productos') &&
    !/\[(producto|servicio|upsell)_imagen_url\]/i.test(respuestaRaw)
  ) {
    try {
      const conImagen = await db.query(
        `SELECT nombre, imagen_url FROM productos_chat_center
          WHERE id_configuracion = ? AND eliminado = 0
            AND imagen_url IS NOT NULL AND imagen_url <> ''`,
        { replacements: [id_configuracion], type: db.QueryTypes.SELECT },
      );

      const norm = (s) =>
        String(s || '')
          .toLowerCase()
          .normalize('NFD')
          .replace(/\p{M}/gu, '')
          .replace(/[^a-z0-9\s]/g, ' ')
          .replace(/\s+/g, ' ')
          .trim();

      const dicho = norm(respuestaRaw);

      // Dos palabras del nombre, igual que en el enrutado: una sola ("facial",
      // "profesional") aparece en medio catálogo.
      const mencionado = conImagen.find((p) => {
        const tk = norm(p.nombre)
          .split(' ')
          .filter((t) => t.length > 3);
        const aciertos = tk.filter((t) => dicho.includes(t)).length;
        return aciertos >= Math.min(2, tk.length);
      });

      if (mencionado) {
        /* No se comprueba acá si ya se envió: de eso se encarga el filtro del
           paso 12, que es por donde pasan también las etiquetas que escribe el
           propio prompt. Tener el control en dos lados fue justamente el
           problema: este lado se cuidaba y el otro mandaba la misma foto en
           cada mensaje.

           Va en su propia variable porque `respuestaRaw` es const: al intentar
           concatenar ahí, el error caía en el catch de abajo y la foto no se
           enviaba nunca, sin una sola señal de que algo falló. */
        adjuntoImagen = `\n[producto_imagen_url]: ${normalizarUrlMedia(
          mencionado.imagen_url,
        )}`;
        /* La propone el código: se registra como ofrecida o el candado de
           propiedad del paso 12 la bloquearía como si fuera del modelo. */
        ofrecerMedia(id_cliente, [normalizarUrlMedia(mencionado.imagen_url)]);
        await log(
          `📷 Se adjunta la foto de "${mencionado.nombre}" (el bot no la había mandado)`,
        );
      }
    } catch (e) {
      await log(`⚠️ No se pudo adjuntar la imagen del producto: ${e.message}`);
    }
  }

  // ── 12. enviar_media — siempre activo ────────────────────
  let soloTexto = respuestaRaw;
  const media = extraerMedia(`${respuestaRaw}${adjuntoImagen}`);
  const { texto } = media;
  soloTexto = texto;

  /* Cierre bloqueado (paso 10): el resumen era la plantilla del prompt, no un
     pedido. Mandárselo al cliente ("Nombre: [nombre completo real]") delata a
     la máquina y da la venta por hecha sin datos, así que la respuesta entera
     se reemplaza por lo único correcto en ese momento: pedir los datos. */
  if (cierreBloqueado) {
    soloTexto =
      'Para confirmar tu pedido, ayúdame con estos datos 😊:\n' +
      '- Nombre completo\n' +
      '- Teléfono\n' +
      '- Ciudad y provincia\n' +
      '- Dirección exacta (dos calles y una referencia), o la agencia ' +
      'Servientrega si prefieres retirarlo';
    media.imagenes = [];
    media.videos = [];
  }

  /* El filtro tiene que estar ACÁ y no donde se decide adjuntarla: la etiqueta
     puede venir del prompt (el modelo la repite en cada mensaje, que es lo que
     hacía llegar la misma imagen dos y tres veces seguidas) o del código. Este
     es el único punto por el que pasan las dos.
     La lógica vive en `utils/dedupeMedia` porque las ramas `ventas` e
     `imporshop` del webhook mandan fotos por su propio camino y necesitan
     exactamente el mismo control. */
  const imagenes = await filtrarMediaNueva({
    id_cliente,
    id_configuracion,
    urls: media.imagenes,
    etiqueta: 'imagen',
    log,
  });
  const videos = await filtrarMediaNueva({
    id_cliente,
    id_configuracion,
    urls: media.videos,
    etiqueta: 'video',
    log,
  });

  for (const url of imagenes) {
    await canal
      .enviarMedia({
        tipo: 'image',
        url,
        responsable: `IA_${columna.nombre}`,
      })
      .catch(async (err) => {
        /* Si el envío falló no quedó fila en `mensajes_clientes`, así que la
           marca en memoria estaría bloqueando una foto que el cliente nunca
           recibió. Se suelta para que el próximo turno pueda reintentar. */
        olvidarEnviado(id_cliente, url);
        await log(`⚠️ Error enviando imagen: ${err.message}`);
      });
  }
  for (const url of videos) {
    await log(`🎥 Intentando enviar video URL: ${url}`);
    try {
      const headRes = await axios.head(url);
      const bytes = headRes.headers['content-length'];
      const mb = bytes ? (bytes / 1024 / 1024).toFixed(2) : 'desconocido';
      await log(`📦 Tamaño video: ${mb} MB`);
    } catch (e) {
      await log(`⚠️ No se pudo verificar tamaño: ${e.message}`);
    }
    await canal
      .enviarMedia({
        tipo: 'video',
        url,
        responsable: `IA_${columna.nombre}`,
      })
      .catch(async (err) => {
        olvidarEnviado(id_cliente, url);
        await log(`⚠️ Error enviando video URL=${url}: ${err.message}`);
      });
  }

  // ── 13. Enviar texto final ────────────────────────────────
  // Limpiar tags de acciones del texto
  soloTexto = limpiarTagsAcciones(soloTexto).trim();

  /* Y las coletillas de relleno ("no dudes en escribirme", "aquí estoy para
     ayudarte"). Están prohibidas en el prompt y el modelo las escribe igual;
     son lo que hace que la conversación se sienta de robot. */
  const antesColetillas = soloTexto;
  soloTexto = limpiarColetillas(soloTexto);
  if (soloTexto !== antesColetillas) {
    await log(`🧹 Coletilla de relleno eliminada del mensaje`);
  }

  /* Y las fechas pasan a lenguaje de persona. El bloque de agendamiento las
     lleva en formato de sistema porque así las parsea el backend sin
     ambigüedad, pero ese bloque también le llega al cliente: leer
     "2026-08-01 10:00" en un WhatsApp delata la máquina. Se traduce acá, ya
     usadas: "mañana sábado 1 de agosto, 10:00". */
  soloTexto = humanizarFechas(soloTexto);

  /* Y el Markdown que WhatsApp no entiende: los ** llegan como asteriscos a
     la vista. Está prohibido en el prompt y el modelo lo escribe igual. */
  soloTexto = limpiarMarkdown(soloTexto);

  /* Resumen de cierre repetido: no se manda.

     Cuando el cliente escribe dos veces seguidas ("En la entrada de ocho" /
     "Hay un Servientrega"), cada mensaje corre su propio turno y el asistente
     cierra la venta en las DOS respuestas. La orden ya la ataja el candado del
     paso 10, pero el cliente igual veía dos "tu pedido queda así" seguidos, que
     es exactamente lo que hizo pensar que se le duplicaban los pedidos.

     Solo se descarta el resumen repetido. El resto de la conversación sale como
     siempre: descartar toda respuesta que quedó vieja tocaría el 28% de los
     mensajes (ver utils/dedupeAutoOrden.js) y eso es otro problema. */
  if (soloTexto && cerroLaVenta && !reclamarResumenCierre(claveResumen)) {
    await log(
      `🔁 Resumen de cierre repetido para cliente=${id_cliente}: no se envía ` +
        `(ya salió uno hace menos de 5 min; el cliente escribió en ráfaga)`,
    );
    soloTexto = '';
  }

  if (soloTexto) {
    // Si la conexión tiene el split activo, la respuesta sale en 2-3 mensajes
    // naturales. Si no, se mantiene el envío de siempre en un solo bloque.
    const [cfgSplit] = await db.query(
      `SELECT ia_split_mensajes FROM configuraciones WHERE id = ? LIMIT 1`,
      { replacements: [id_configuracion], type: db.QueryTypes.SELECT },
    );

    if (cfgSplit?.ia_split_mensajes) {
      const r = await enviarEnBloques({
        canal,
        texto: soloTexto,
        responsable: `IA_${columna.nombre}`,
        total_tokens,
        id_cliente,
        turno,
        log,
      });
      await log(
        `✉️ Respuesta enviada en ${r.bloques} mensaje(s)` +
          (r.enSegundoPlano ? ` (${r.enSegundoPlano} en segundo plano)` : ''),
      );
    } else {
      await canal.enviarTexto({
        texto: soloTexto,
        responsable: `IA_${columna.nombre}`,
        total_tokens,
      });
    }
  }

  // ✅ Si llegó hasta aquí, OpenAI está funcionando
  await marcarOpenAIActivo(id_configuracion);

  return { ok: true, respuesta_enviada: soloTexto, total_tokens };
}

// ══════════════════════════════════════════════════════════════
// limpiarCitasFileSearch
// Borra las citas 【X:Y†source】 que OpenAI inyecta automáticamente
// cuando el asistente usa file_search. Dos capas: annotations
// (método oficial por índices) + regex de respaldo.
// ══════════════════════════════════════════════════════════════
function limpiarCitasFileSearch(textBlock) {
  if (!textBlock?.value) return '';
  let texto = textBlock.value;
  const anns = textBlock.annotations || [];

  // Capa 1: borrar por índices exactos (de atrás hacia adelante
  // para no desfasar las posiciones restantes)
  for (let i = anns.length - 1; i >= 0; i--) {
    const a = anns[i];
    if (
      typeof a?.start_index === 'number' &&
      typeof a?.end_index === 'number'
    ) {
      texto = texto.slice(0, a.start_index) + texto.slice(a.end_index);
    }
  }

  // Capa 2: regex de respaldo por si algún formato cambia
  texto = texto
    .replace(/【[^】]*】/g, '')
    .replace(/\[\d+:\d+†[^\]]*\]/g, '')
    .replace(/\[source\]/gi, '')
    .replace(/\[doc\d+\]/gi, '');

  // Limpiar espacios y puntuación que quedaron colgando
  return (
    texto
      // quita espacios horizontales (NO enters) antes de puntuación
      .replace(/[ \t]+([.,;:!?])/g, '$1')
      // colapsa SOLO espacios/tabs horizontales repetidos, deja los \n
      .replace(/[ \t]{2,}/g, ' ')
      // opcional: máximo 2 saltos de línea seguidos (evita huecos enormes)
      .replace(/\n{3,}/g, '\n\n')
      // limpia espacios al final de cada línea
      .replace(/[ \t]+$/gm, '')
      .trim()
  );
}

function limpiarCitasResponsesAPI(text, annotations = []) {
  if (!text) return '';
  let texto = text;

  const sortedAnns = [...annotations].sort(
    (a, b) => (b.start_index || 0) - (a.start_index || 0),
  );
  for (const a of sortedAnns) {
    if (
      typeof a?.start_index === 'number' &&
      typeof a?.end_index === 'number'
    ) {
      texto = texto.slice(0, a.start_index) + texto.slice(a.end_index);
    }
  }

  texto = texto
    .replace(/【[^】]*】/g, '')
    .replace(/\[\d+:\d+†[^\]]*\]/g, '')
    .replace(/\[source\]/gi, '')
    .replace(/\[doc\d+\]/gi, '');

  return texto
    .replace(/[ \t]+([.,;:!?])/g, '$1')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]+$/gm, '')
    .trim();
}

// ══════════════════════════════════════════════════════════════
// ejecutarAsistente — polling OpenAI
// ══════════════════════════════════════════════════════════════
async function ejecutarAsistente({
  id_thread,
  assistant_id,
  mensaje,
  max_tokens = 500,
  headers,
  skip_send_message = false,
  additional_instructions = null,
}) {
  try {
    if (!skip_send_message && mensaje) {
      await axios.post(
        `https://api.openai.com/v1/threads/${id_thread}/messages`,
        { role: 'user', content: mensaje },
        { headers },
      );
    }

    const runBody = { assistant_id, max_completion_tokens: max_tokens };
    if (additional_instructions) {
      runBody.additional_instructions = additional_instructions;
      // Solo el principio: desde que el catálogo inline entra por acá, volcarlo
      // entero mete hasta ~64.000 caracteres por mensaje en debug_log.txt.
      await log(
        `📎 additional_instructions inyectado (${additional_instructions.length} chars): ` +
          `${additional_instructions.slice(0, 300)}${additional_instructions.length > 300 ? '…' : ''}`,
      );
    }

    const runRes = await axios.post(
      `https://api.openai.com/v1/threads/${id_thread}/runs`,
      runBody,
      { headers },
    );
    const run_id = runRes?.data?.id;
    if (!run_id) throw new Error('No se pudo crear run');

    let statusRun = 'queued';
    let attempts = 0;
    let total_tokens = 0;

    while (
      statusRun !== 'completed' &&
      statusRun !== 'failed' &&
      attempts < 45
    ) {
      await new Promise((r) => setTimeout(r, 2000));
      attempts++;
      const statusRes = await axios.get(
        `https://api.openai.com/v1/threads/${id_thread}/runs/${run_id}`,
        { headers },
      );
      statusRun = statusRes.data.status;
      if (statusRes.data.usage) {
        total_tokens = statusRes.data.usage.total_tokens || 0;
      }
      await log(`run ${run_id} intento=${attempts} status=${statusRun}`);

      if (statusRun === 'failed') {
        const lastErr = statusRes.data.last_error;
        throw new Error(`Run falló: ${JSON.stringify(lastErr)}`);
      }
    }

    if (statusRun !== 'completed')
      throw new Error(`Run no completó (status=${statusRun})`);

    const messagesRes = await axios.get(
      `https://api.openai.com/v1/threads/${id_thread}/messages`,
      { headers },
    );
    const mensajes = messagesRes.data.data || [];
    const textBlock = mensajes
      .reverse()
      .find((m) => m.role === 'assistant' && m.run_id === run_id)
      ?.content?.[0]?.text;

    const respuesta = limpiarCitasFileSearch(textBlock);
    return { respuesta, total_tokens };
  } catch (err) {
    if (esSinSaldo(err)) {
      await log(`🚨 SIN SALDO OPENAI: ${mensajeErrorOpenAI(err)}`);
      // Se pierde el error original al relanzar, así que el motivo viaja en la
      // propiedad para que quien lo capture arriba pueda guardarlo tal cual.
      const e = new Error('sin_saldo_openai');
      e.code = 'sin_saldo_openai';
      e.motivoOpenAI = mensajeErrorOpenAI(err);
      throw e;
    }
    throw err;
  }
}

async function ejecutarConResponsesAPI({
  previous_response_id,
  instructions,
  additional_instructions,
  input,
  model,
  max_tokens,
  vector_store_id,
  api_key_openai,
  // Opcional a propósito: quien no lo pase se queda con el comportamiento de
  // siempre (sin tope de fragmentos). Se agregó así, y no renombrando
  // vector_store_id, para no romper a remarketing_ig.service.js.
  id_configuracion,
  // Vector store de documentos subidos por el usuario. Va aparte del catálogo
  // porque son cosas distintas: el catálogo puede viajar inline (y entonces
  // vector_store_id llega en null), pero los documentos solo se pueden
  // consultar por búsqueda. También opcional por la misma razón.
  vector_store_docs_id,
}) {
  const headers = {
    Authorization: `Bearer ${api_key_openai}`,
    'Content-Type': 'application/json',
  };

  let finalInstructions = instructions || '';
  if (additional_instructions) {
    finalInstructions += '\n\n' + additional_instructions;
  }

  // Como máximo son dos: catálogo y documentos —justo el límite que acepta la
  // API—. Con el catálogo inline el primero llega en null y queda solo el de
  // documentos; si no hay ninguno, toolFileSearchResponses devuelve null y no
  // se manda la herramienta.
  const tools = [];
  const toolBusqueda = toolFileSearchResponses(
    [vector_store_id, vector_store_docs_id],
    id_configuracion,
  );
  if (toolBusqueda) {
    tools.push(toolBusqueda);
  }

  const body = {
    model: model || 'gpt-4o-mini',
    instructions: finalInstructions,
    input,
    store: true,
    max_output_tokens: max_tokens || 500,
  };

  if (previous_response_id) {
    body.previous_response_id = previous_response_id;
  }

  if (tools.length > 0) {
    body.tools = tools;
  }

  const res = await axios.post('https://api.openai.com/v1/responses', body, {
    headers,
    timeout: 60000,
  });

  const response_id = res.data.id;
  const total_tokens = res.data.usage?.total_tokens || 0;

  const outputItems = res.data.output || [];
  const messageItem = outputItems.find((item) => item.type === 'message');
  const textContent = messageItem?.content?.find(
    (c) => c.type === 'output_text',
  );

  const rawText = textContent?.text || '';
  const annotations = textContent?.annotations || [];

  const respuesta = limpiarCitasResponsesAPI(rawText, annotations);

  return { respuesta, response_id, total_tokens };
}

// ══════════════════════════════════════════════════════════════
// Helpers de procesamiento de respuesta
// ══════════════════════════════════════════════════════════════

/* Delega en `utils/urlsMedia`: el patrón que estaba acá cortaba la url en el
   primer espacio, y las urls de Dropi los traen (el nombre del objeto es el
   archivo que subió el vendedor). Eso mandaba a Meta un link recortado que
   nunca se entregaba, y de paso rompía el dedupe. */
function extraerMedia(texto) {
  return extraerUrlsMedia(texto);
}

/**
 * Traduce la ubicación que llega por WhatsApp a algo que un modelo pueda leer.
 *
 * El webhook guarda el JSON crudo de Meta porque el chat lo usa para pintar el
 * mapita. Para el asistente eso no es un mensaje: es ruido, y responde pidiendo
 * "la dirección en palabras" a alguien que le acaba de mandar exactamente eso.
 *
 * Devuelve `null` si el texto no es una ubicación, para que el mensaje siga su
 * camino sin tocarse.
 */
function textoDeUbicacion(texto) {
  const s = String(texto || '').trim();
  if (!s.startsWith('{') || !s.includes('latitude')) return null;

  try {
    const o = JSON.parse(s);
    const lat = Number(o?.latitude);
    const lng = Number(o?.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;

    return (
      `[El cliente compartió su ubicación por WhatsApp]\n` +
      `Coordenadas: ${lat}, ${lng}\n` +
      `Mapa: https://www.google.com/maps?q=${lat},${lng}\n` +
      `Ya tienes su ubicación: NO se la vuelvas a pedir ni le pidas la ` +
      `dirección "en palabras". Si necesitas el nombre del sector o una ` +
      `referencia para llegar, pídele eso puntual. Cuando tengas que dejar la ` +
      `ubicación registrada en una ficha, escribe el enlace del mapa tal cual.`
    );
  } catch {
    return null;
  }
}

/* ── Qué ítem del catálogo nombró el bot ────────────────────────
   El prompt le pide el nombre EXACTO y el modelo lo parafrasea igual: para
   "Arriendo casa Cumbayá" escribió "Visita — Casa Cumbayá". Con coincidencia
   por subcadena eso no calza en ninguna dirección —ni el pedido contiene al
   nombre ni al revés— así que la visita se creaba sin el inmueble atado, y por
   lo tanto sin su dirección: terminaba citando en la oficina, que es justo lo
   que se vino a arreglar. Y sin un solo error a la vista.

   Se compara por PALABRAS compartidas. Las genéricas no cuentan: si contaran,
   "Visita — Casa Cumbayá" empataría con cualquier otra casa del catálogo por
   la palabra "casa". */
const GENERICAS_ITEM = new Set([
  'visita',
  'visitar',
  'ver',
  'cita',
  'para',
  'del',
  'de',
  'la',
  'el',
  'los',
  'las',
  'en',
  'con',
  'por',
  'un',
  'una',
  'al',
  'y',
  'o',
  'arriendo',
  'arrendar',
  'alquiler',
  'venta',
  'vender',
  'compra',
  'comprar',
  'inmueble',
  'propiedad',
  'servicio',
]);

/* El TIPO de inmueble tampoco identifica cuál es. "Visita — Casa en
   Samborondón" comparte la palabra "casa" con "Arriendo casa Cumbayá" y con
   otras diez: si eso alcanzara para atar el ítem, se agendaría una visita a la
   casa equivocada, con la dirección equivocada. Lo que identifica es el nombre
   propio —el sector, el barrio, el edificio— así que se exige compartir al
   menos uno de esos. */
const TIPOS_ITEM = new Set([
  'casa',
  'casas',
  'departamento',
  'departamentos',
  'depto',
  'suite',
  'suites',
  'terreno',
  'terrenos',
  'lote',
  'local',
  'locales',
  'oficina',
  'oficinas',
  'bodega',
  'bodegas',
  'galpon',
  'galpones',
  'penthouse',
  'loft',
  'villa',
  'quinta',
  'chalet',
  'edificio',
  'consultorio',
]);

const normalizarItem = (s) =>
  String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const tokensItem = (s) =>
  normalizarItem(s)
    .split(' ')
    .filter((t) => t.length > 2);

const distintivos = (toks) => toks.filter((t) => !GENERICAS_ITEM.has(t));

/**
 * Elige del catálogo el ítem que el bot quiso nombrar.
 *
 * @param {string} pedido    lo que escribió en "Servicio que desea"
 * @param {Array<{nombre:string}>} catalogo
 * @returns el ítem, o null si nada se parece lo suficiente
 */
function elegirItemDelCatalogo(pedido, catalogo) {
  const pedidoNorm = normalizarItem(pedido);
  if (!pedidoNorm) return null;

  const pedidoToks = new Set(tokensItem(pedido));

  /* Se puntúa por cuántas palabras IDENTIFICATORIAS comparten —el sector, el
     barrio, el edificio— y no por qué proporción del nombre coincide. Los
     nombres reales del catálogo son verbosos ("Suite Moderna Amoblada Sector El
     Bosque") y el modelo los acorta ("Suite El Bosque"): exigir la mitad de las
     palabras dejaba fuera justo los casos normales. */
  const candidatos = [];

  for (const item of catalogo || []) {
    const nombreNorm = normalizarItem(item.nombre);
    if (!nombreNorm) continue;

    // El nombre exacto, o contenido de un lado o del otro: no hay nada que dudar.
    if (
      nombreNorm === pedidoNorm ||
      (nombreNorm.length > 3 &&
        (pedidoNorm.includes(nombreNorm) || nombreNorm.includes(pedidoNorm)))
    ) {
      return item;
    }

    const propios = distintivos(tokensItem(item.nombre));
    if (!propios.length) continue;

    const compartidos = propios.filter((t) => pedidoToks.has(t));
    if (!compartidos.length) continue;

    /* Tiene que coincidir en algo que IDENTIFIQUE al inmueble, no solo en su
       tipo. Si el ítem no tiene ninguna palabra identificatoria —alguien lo
       llamó "Casa" y nada más— se acepta el tipo, que es todo lo que hay. */
    const identificadores = propios.filter((t) => !TIPOS_ITEM.has(t));
    const idsCompartidos = identificadores.filter((t) => pedidoToks.has(t));

    if (identificadores.length && !idsCompartidos.length) continue;
    if (!identificadores.length && compartidos.length / propios.length < 0.5) {
      continue;
    }

    candidatos.push({
      item,
      ids: idsCompartidos.length,
      ratio: compartidos.length / propios.length,
    });
  }

  if (!candidatos.length) return null;

  candidatos.sort((a, b) => b.ids - a.ids || b.ratio - a.ratio);

  /* Empate real: dos inmuebles del catálogo coinciden igual de bien. Pasa con
     dos unidades en el mismo edificio. Devolver cualquiera sería mandar a
     alguien a la puerta equivocada, y eso es peor que no resolver el ítem —el
     caller lo registra y la cita cae en la sede, donde al menos hay alguien. */
  const [primero, segundo] = candidatos;
  if (
    segundo &&
    segundo.ids === primero.ids &&
    segundo.ratio === primero.ratio
  ) {
    return null;
  }

  return primero.item;
}

/**
 * Traduce los textos que escribe el SISTEMA, no el cliente.
 *
 * Cuando llega un tipo de mensaje que no se puede leer —un sticker, una
 * encuesta, un mensaje eliminado— el webhook guarda un texto de relleno
 * ("Tipo de mensaje no reconocido.") para que el chat muestre algo. Ese texto
 * viajaba al asistente COMO SI LO HUBIERA ESCRITO LA PERSONA, y ahí pasaban dos
 * cosas, las dos malas:
 *
 *   1. El bot tenía que adivinar qué quiere alguien que dijo "Tipo de mensaje
 *      no reconocido", y adivinaba.
 *   2. Peor: el selector de productos de contextoColumna busca coincidencias por
 *      palabra, y "tipo" está en un montón de nombres de catálogo ("Cable Tipo
 *      C 240W"). Con eso, al bot se le inyectaba la ficha completa de ese
 *      producto bajo el título "Ficha de lo que la persona nombró" y la orden
 *      de mandarle la foto. No inventaba nada: hacía lo que le decíamos.
 *
 * Devuelve `null` si el texto es del cliente y no hay nada que traducir.
 */
/* Los textos que escribe el webhook cuando el mensaje no viene como texto. Cada
   uno sale de un `case` de webhook_meta_whatsapp.controller.js, y hay que
   mirarlos todos: el sticker —el caso más común de "no me llegó bien"— quedaba
   fuera y el bot tenía que contestarle a "Sticker recibido y guardado con ID:
   4471…" como si eso lo hubiera escrito una persona. */
const RELLENOS_SISTEMA = [
  /^tipo de mensaje no reconocido\.?$/i, // case default
  /^🚫?\s*mensaje eliminado por el usuario\.?$/i, // case revoke
  /^sticker recibido y guardado con id/i, // case sticker
  /^error al descargar/i,
  /* case document sin caption: se guarda el nombre del archivo. Un mensaje que
     es exactamente un nombre de archivo no es una pregunta de nadie. */
  /^[\w\-. ()]{1,80}\.(pdf|docx?|xlsx?|pptx?|txt|csv|zip|rar|jpe?g|png|webp|mp4)$/i,
];

/* Una reacción es otra cosa: el cliente no mandó un mensaje nuevo, le puso un
   emoji al anterior. Decirle al bot "no sabes qué quiere, preguntale qué
   producto" ahí sería absurdo — sí sabe de qué venían hablando. */
const soloEmojis = (s) =>
  s.length <= 8 && /^[\p{Emoji}️‍\s]+$/u.test(s) && /\p{Emoji}/u.test(s);

function textoDeMensajeIlegible(texto) {
  const s = String(texto || '').trim();
  if (!s) return null;

  if (soloEmojis(s)) {
    return (
      `[El cliente reaccionó con ${s} a tu mensaje anterior. No escribió nada más.]\n` +
      `No es una consulta nueva y NO nombró ningún producto: no le ofrezcas uno ` +
      `ni le mandes fotos por esto.\n` +
      `Si venían en medio de algo, continúa con eso. Si la conversación ya estaba ` +
      `cerrada, responde en UNA línea corta y no preguntes nada.`
    );
  }

  if (!RELLENOS_SISTEMA.some((re) => re.test(s))) return null;

  return (
    `[El cliente envió algo que no se puede leer: un sticker, una encuesta, un ` +
    `archivo, un mensaje eliminado o un formato que WhatsApp no entrega como ` +
    `texto.]\n` +
    `NO sabes qué dice. Está PROHIBIDO suponerlo, y sobre todo está prohibido ` +
    `ofrecerle un producto del catálogo: nadie lo mencionó.\n` +
    `Si ya venían hablando de algo concreto, retoma ESO y pregúntale qué quiso ` +
    `decir. Si no sabes de qué venía la conversación, dile en UNA línea que no te ` +
    `llegó bien y pregúntale qué producto le interesa. Nada más: ni foto, ni ` +
    `precio, ni ciudad.`
  );
}

function limpiarTagsAcciones(texto) {
  return texto
    .replace(/\[pedido_confirmado\]:\s*(true|false)/gi, '')
    .replace(/\[cita_confirmada\]:\s*(true|false)/gi, '')
    .replace(/\[asesor_confirmado\]:\s*(true|false)/gi, '')
    .replace(/\[atencion_urgente\]:\s*(true|false)/gi, '')
    .replace(/\[[^\]]+\]:\s*(true|false)/gi, '') // cualquier tag booleano
    .trim();
}

/**
 * @param {string} mensajeGPT   respuesta cruda del modelo, con el bloque de cita
 * @param {number} id_configuracion
 * @param {number} id_cliente
 * @param {{lugar_cita?: 'sede'|'item', modo?: 'auto'|'solicitud'}} [opciones]
 *   Las dos salen de la config de la acción `agendar_cita` de la columna.
 *
 *   `lugar_cita`:
 *     - 'sede' (default): la cita se hace en el local, como siempre.
 *     - 'item': se hace donde queda el ítem del catálogo. Es el caso de
 *       inmobiliaria — la visita es en la casa, no en la oficina—, y por eso el
 *       lugar sale de la dirección cargada en el ítem y no de la sede.
 *
 *   `modo`:
 *     - 'auto' (default): se crea la cita en el calendario.
 *     - 'solicitud': NO se toca el calendario. Se guarda el pedido en
 *       `citas_solicitudes` para que una persona lo confirme. Es para las
 *       agendas donde enterarse de una visita 20 minutos antes no es una
 *       opción: quien atiende puede estar durmiendo o manejando.
 */
async function procesarAgendarCita(
  mensajeGPT,
  id_configuracion,
  id_cliente,
  opciones = {},
) {
  const moment = require('moment-timezone');
  const lugarCita = opciones?.lugar_cita === 'item' ? 'item' : 'sede';
  const modo = opciones?.modo === 'solicitud' ? 'solicitud' : 'auto';

  /* El bloque llega tal como lo escribió el modelo, y el modelo pone negritas
     cuando le parece: "🧑 **Nombre:** Ana". Con el emoji y los asteriscos
     obligatorios en el patrón, ese bloque no matcheaba NADA — la cita se creaba
     con los campos vacíos y una fecha inválida, sin un solo error a la vista.
     Se quita el énfasis antes de leer y el emoji queda opcional. */
  const limpio = String(mensajeGPT || '').replace(/[*_]{1,2}/g, '');
  const campo = (etiqueta) =>
    limpio.match(new RegExp(`${etiqueta}\\s*:\\s*(.+)`, 'i'))?.[1]?.trim() ||
    '';

  const nombre = campo('Nombre');
  const correo = campo('Correo');
  const servicio = campo('Servicio que desea');

  /* El teléfono que vale es el que la persona DIO: puede querer que la llamen a
     otro número distinto del que usa para escribir. El del webhook es el
     respaldo, para cuando contestó "a este mismo" o cuando el modelo no logró
     que se lo dieran. Antes se forzaba siempre el del webhook y se perdía el
     número real que la clienta había dejado. */
  const [contacto] = await db.query(
    `SELECT celular_cliente FROM clientes_chat_center WHERE id = ? LIMIT 1`,
    { replacements: [id_cliente], type: db.QueryTypes.SELECT },
  );

  const telefonoBloque = campo('Tel[eé]fono');

  /* "este mismo", "el de siempre", "no registra": no son números. Se toman como
     que hay que usar el del webhook. */
  const esReferencia =
    !telefonoBloque ||
    /no registra|mismo|este n[uú]mero|desde donde|el de ac[aá]|<|>/i.test(
      telefonoBloque,
    ) ||
    telefonoBloque.replace(/\D/g, '').length < 7;

  const telefono = esReferencia
    ? contacto?.celular_cliente || ''
    : telefonoBloque;

  if (esReferencia && telefonoBloque) {
    await log(
      `📞 agendar_cita: "${telefonoBloque}" no es un número; se usa el del webhook`,
    );
  }
  /* La hora de fin ya no se le pide al modelo: el resumen que ve el cliente era
     larguísimo y esa línea no le dice nada. Se calcula con la duración que tiene
     el servicio en el catálogo. Se sigue leyendo si viene, para no romper las
     cuentas cuyo prompt todavía la incluye. */
  const fechaIni = campo('Fecha y hora de inicio') || campo('Fecha y hora');
  const fechaFin = campo('Fecha y hora de fin');

  /* ── Qué ítem del catálogo se va a ver ──────────────────────────
     Sale de "Servicio que desea". Se resuelve ANTES de las fechas porque su
     `duracion` es la que decide la hora de fin: antes eso se buscaba con un
     LIKE aparte que fallaba con los mismos nombres parafraseados, y la visita
     quedaba de 60 minutos aunque el inmueble dijera 45. */
  let itemAgendado = null;

  if (servicio) {
    const catalogo = await db.query(
      `SELECT id, nombre, tipo, duracion, id_establecimiento, direccion,
              sector, ciudad, latitud, longitud, google_maps_url
         FROM productos_chat_center
        WHERE id_configuracion = ? AND eliminado = 0`,
      { replacements: [id_configuracion], type: db.QueryTypes.SELECT },
    );

    itemAgendado = elegirItemDelCatalogo(servicio, catalogo);

    if (!itemAgendado) {
      /* Se avisa porque es silencioso y caro: sin ítem atado, la visita se crea
         con la dirección de la sede y quien atiende sale para la oficina. */
      await log(
        `⚠️ agendar_cita: "${servicio}" no coincide con ningún ítem del catálogo ` +
          `de la configuración ${id_configuracion}`,
      );
    }
  }

  const mIni = moment.tz(fechaIni, 'YYYY-MM-DD HH:mm', 'America/Guayaquil');

  if (!mIni.isValid()) {
    /* Sin fecha legible no hay cita posible. Pero sí hay solicitud: alguien que
       quiere ver algo y dijo "el sábado en la mañana" es exactamente el lead
       que no se puede perder, y quien confirma va a leer esa frase igual. Se
       guarda con la fecha vacía y el texto tal cual. */
    if (modo === 'solicitud') {
      await log(
        `📝 agendar_cita (solicitud): fecha no interpretable ("${fechaIni}"); se guarda la preferencia como texto`,
      );
    } else {
      await log(
        `❌ agendar_cita: fecha ilegible en el bloque (inicio="${fechaIni}"); la cita NO se creó`,
      );
      return { ok: false, motivo: 'fecha ilegible en el bloque' };
    }
  }

  let mFin = fechaFin
    ? moment.tz(fechaFin, 'YYYY-MM-DD HH:mm', 'America/Guayaquil')
    : null;

  if (mIni.isValid() && (!mFin || !mFin.isValid() || !mFin.isAfter(mIni))) {
    // La duración del ítem que se resolvió arriba. 60 es el último recurso.
    const minutos =
      Number(itemAgendado?.duracion) > 0 ? Number(itemAgendado.duracion) : 60;
    mFin = mIni.clone().add(minutos, 'minutes');
    await log(
      `🕒 agendar_cita: hora de fin calculada (${minutos} min de ` +
        `"${itemAgendado?.nombre || servicio || 'sin servicio'}")`,
    );
  }

  const inicio_utc = mIni.isValid() ? mIni.utc().format() : null;
  const fin_utc = mFin && mFin.isValid() ? mFin.utc().format() : null;

  if (servicio) {
    /* Un producto no se agenda, se entrega. El bot igual arma citas de
       "recogida" cuando la clienta quiere comprar algo, y eso le ocupa un cupo
       real de la agenda a un tratamiento. Se corta acá y no solo en el prompt:
       si lo que escribió en "Servicio" es un producto del catálogo, no hay cita
       y el caso pasa a un asesor, que es quien cierra la venta.

       La excepción es la cita EN el ítem. Ahí lo que se agenda es ir a verlo, y
       un inmueble cargado como producto es perfectamente legítimo: el guard lo
       reconoce por su ubicación propia, que es justo lo que un producto de
       dropshipping nunca va a tener. */
    const esProducto =
      itemAgendado &&
      String(itemAgendado.tipo || '').toLowerCase() !== 'servicio';
    const seVisitaEnSitio =
      lugarCita === 'item' && String(itemAgendado?.direccion || '').trim();

    if (esProducto && !seVisitaEnSitio) {
      await log(
        `⛔ agendar_cita: "${servicio}" es un producto del catálogo, no un servicio; la cita NO se creó`,
      );
      return {
        ok: false,
        motivo: `"${servicio}" es un producto: se vende y se entrega, no se agenda`,
      };
    }
  }

  /* Sede elegida por el bot. Si la cuenta tiene varias sucursales, la cita va al
     calendario de ESA sede; si no, al único que exista. Antes siempre se tomaba
     el primer calendario de la cuenta (LIMIT 1 sin orden), así que una cuenta
     con dos sedes agendaba todo en la misma agenda. */
  /* El bloque ahora lleva "Sede La Carolina — Av. Amazonas 123" porque al
     cliente la dirección le sirve y el nombre solo no. Para buscar la sede se
     usa lo que va antes del guion. */
  const sedeNombre = campo('Sede')
    .split(/\s+[—–-]\s+/)[0]
    .trim();

  const sedes = await db.query(
    `SELECT id, nombre, ciudad, direccion, id_calendario, buffer_minutos
       FROM establecimientos_chat_center
      WHERE id_configuracion = ? AND eliminado = 0 AND activo = 1
      ORDER BY orden ASC, id ASC`,
    { replacements: [id_configuracion], type: db.QueryTypes.SELECT },
  );

  let establecimiento = null;

  /* Cuando la visita es en el ítem, la oficina la decide el ítem y no el bot:
     cada inmueble está a cargo de una sucursal, y esa es la agenda donde tiene
     que caer la visita y de donde sale el corredor. Lo que el modelo haya
     escrito en "Sede" acá no manda — cambiar de oficina por una palabra mal
     copiada deja al corredor equivocado esperando. */
  const sedeDelItem =
    lugarCita === 'item' && itemAgendado?.id_establecimiento
      ? sedes.find(
          (s) => Number(s.id) === Number(itemAgendado.id_establecimiento),
        ) || null
      : null;

  if (sedeDelItem) {
    establecimiento = sedeDelItem;
  } else if (sedes.length === 1) {
    // Con una sola sede no hay nada que elegir, escriba lo que escriba el bot.
    establecimiento = sedes[0];
  } else if (sedeNombre && sedes.length) {
    // Sin tildes ni dobles espacios: "Sede La Carolína" y "la carolina" son la misma.
    const norm = (s) =>
      String(s || '')
        .toLowerCase()
        .normalize('NFD')
        .replace(/\p{M}/gu, '')
        .replace(/\s+/g, ' ')
        .trim();
    const buscado = norm(sedeNombre);

    /* Coincidencia flexible a propósito: el bot abrevia ("La Carolina" por
       "Sede La Carolina"). Con igualdad exacta eso caía al calendario por
       defecto y una cuenta de varias sedes agendaba en la sucursal equivocada
       sin avisar. */
    establecimiento =
      sedes.find((s) => norm(s.nombre) === buscado) ||
      sedes.find(
        (s) =>
          norm(s.nombre).includes(buscado) || buscado.includes(norm(s.nombre)),
      ) ||
      null;

    if (!establecimiento) {
      await log(
        `⚠️ agendar_cita: el bot mencionó la sede "${sedeNombre}" y no coincide con ninguna de la configuración ${id_configuracion}`,
      );
    }
  }

  /* ── Modo solicitud: hasta acá y no más ─────────────────────────
     Todo lo de arriba —quién es, qué quiere ver, cuándo, en qué oficina— es el
     trabajo que el bot hace bien y que no hay razón para repetir a mano. Lo que
     no hace es tocar el calendario: eso lo decide una persona.

     Se corta antes de buscar el sub-usuario y de crear la agenda porque nada de
     eso hace falta todavía; se resuelve al confirmar, con quien confirma. */
  if (modo === 'solicitud') {
    const [yaPendiente] = await db.query(
      `SELECT id FROM citas_solicitudes
        WHERE id_configuracion = ? AND id_cliente = ? AND estado = 'pendiente'
        ORDER BY id DESC LIMIT 1`,
      {
        replacements: [id_configuracion, id_cliente],
        type: db.QueryTypes.SELECT,
      },
    );

    /* El bot reescribe el bloque cuando la persona responde "perfecto" o
       cambia de idea sobre el horario. Sin esto, cada mensaje deja otra
       solicitud y quien confirma ve la misma persona cuatro veces. Se
       actualiza la que ya estaba: lo último que dijo es lo que vale. */
    const datos = {
      id_producto: itemAgendado?.id || null,
      id_establecimiento: establecimiento?.id || null,
      nombre: (nombre || '').slice(0, 150) || null,
      telefono: (telefono || '').slice(0, 30) || null,
      correo: (correo || '').slice(0, 150) || null,
      servicio: (servicio || '').slice(0, 255) || null,
      preferencia_texto: (fechaIni || '').slice(0, 255) || null,
      inicio_sugerido: inicio_utc
        ? moment.utc(inicio_utc).format('YYYY-MM-DD HH:mm:ss')
        : null,
      duracion_minutos:
        inicio_utc && fin_utc
          ? Math.max(
              15,
              moment.utc(fin_utc).diff(moment.utc(inicio_utc), 'minutes'),
            )
          : null,
    };

    if (yaPendiente) {
      await db.query(
        `UPDATE citas_solicitudes
            SET id_producto = ?, id_establecimiento = ?, nombre = ?, telefono = ?,
                correo = ?, servicio = ?, preferencia_texto = ?, inicio_sugerido = ?,
                duracion_minutos = ?, updated_at = NOW()
          WHERE id = ?`,
        {
          replacements: [
            datos.id_producto,
            datos.id_establecimiento,
            datos.nombre,
            datos.telefono,
            datos.correo,
            datos.servicio,
            datos.preferencia_texto,
            datos.inicio_sugerido,
            datos.duracion_minutos,
            yaPendiente.id,
          ],
          type: db.QueryTypes.UPDATE,
        },
      );
      await log(
        `📝 Solicitud de cita ${yaPendiente.id} actualizada: ${nombre} · ${servicio || 'sin ítem'} · ${fechaIni || 'sin fecha'}`,
      );
      return { ok: true, modo: 'solicitud', id_solicitud: yaPendiente.id };
    }

    const [idNuevo] = await db.query(
      `INSERT INTO citas_solicitudes
         (id_configuracion, id_cliente, id_producto, id_establecimiento, nombre,
          telefono, correo, servicio, preferencia_texto, inicio_sugerido,
          duracion_minutos, estado)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pendiente')`,
      {
        replacements: [
          id_configuracion,
          id_cliente,
          datos.id_producto,
          datos.id_establecimiento,
          datos.nombre,
          datos.telefono,
          datos.correo,
          datos.servicio,
          datos.preferencia_texto,
          datos.inicio_sugerido,
          datos.duracion_minutos,
        ],
        type: db.QueryTypes.INSERT,
      },
    );

    await log(
      `📝 Solicitud de cita registrada (#${idNuevo}): ${nombre} · ${servicio || 'sin ítem'} · ${fechaIni || 'sin fecha'}`,
    );

    return { ok: true, modo: 'solicitud', id_solicitud: idNuevo };
  }

  /* El alta de la cita vive en citas_agenda.service: elegir la agenda, repartir
     a quien atiende, respetar el traslado y decidir la dirección son las mismas
     decisiones cuando confirma una persona desde el panel de solicitudes. Dos
     copias de eso se separan a la primera corrección y nadie se entera hasta
     que una visita cae en la sucursal equivocada. */
  const resultado = await crearCitaAgendada({
    id_configuracion,
    establecimiento,
    item: itemAgendado,
    lugar_cita: lugarCita,
    nombre,
    telefono,
    correo,
    servicio,
    inicio_utc,
    fin_utc,
    profesional_pedido: campo('Atiende'),
  });

  return resultado;
}

/**
 * Columnas donde el seguimiento NO se apaga porque el cliente conteste.
 *
 * En las columnas de venta, una respuesta significa "ya reaccionó, deja de
 * perseguirlo" y por eso cancelarRemarketingKanban apaga enviar_remarketing.
 * En retiro en agencia significa lo contrario: el paquete sigue físicamente en
 * la agencia y "mañana paso" no es haberlo retirado. Aquí el seguimiento solo
 * termina cuando el contacto SALE de la columna — porque el bot confirmó el
 * retiro (y lo movió a entregada), porque pasó a un asesor, o porque Dropi
 * cambió el estado del envío.
 *
 * El cron respeta ese límite por su lado: si el estado_contacto ya no coincide
 * con el de la fila, la cancela sin enviar.
 */
const COLUMNAS_SEGUIMIENTO_PERSISTENTE = new Set(['retiro_agencia']);

// ══════════════════════════════════════════════════════════════
// cancelarRemarketingKanban
// Se llama SIEMPRE que el cliente envía un mensaje en modo kanban
// ══════════════════════════════════════════════════════════════
async function cancelarRemarketingKanban(id_cliente, id_configuracion) {
  try {
    // 1) Verificar si YA se le envió un remarketing a este cliente
    //    (para saber si está respondiendo a un remarketing o iniciando conversación)
    const [remarketingEnviado] = await db.query(
      `SELECT id FROM remarketing_pendientes
       WHERE id_cliente_chat_center = ?
         AND id_configuracion = ?
         AND enviado = 1
         AND cancelado = 0
       LIMIT 1`,
      {
        replacements: [id_cliente, id_configuracion],
        type: db.QueryTypes.SELECT,
      },
    );

    // 2) Cancelar los remarketings pendientes (los que aún no salieron)
    await db.query(
      `UPDATE remarketing_pendientes
       SET cancelado = 1
       WHERE id_cliente_chat_center = ?
         AND id_configuracion = ?
         AND enviado = 0
         AND cancelado = 0`,
      {
        replacements: [id_cliente, id_configuracion],
        type: db.QueryTypes.UPDATE,
      },
    );

    // 3) Si ya se le había enviado remarketing → el cliente está respondiendo
    //    a ese remarketing → apagar flag para no seguir persiguiéndolo.
    //    Si no había enviado nada → dejar el flag como está.
    if (remarketingEnviado) {
      await db.query(
        `UPDATE clientes_chat_center
         SET enviar_remarketing = 0
         WHERE id = ?`,
        {
          replacements: [id_cliente],
          type: db.QueryTypes.UPDATE,
        },
      );
      await log(
        `✅ Remarketing cancelado + enviar_remarketing=0 (respondió a RMK id=${remarketingEnviado.id}) cliente=${id_cliente}`,
      );
    } else {
      await log(
        `✅ Remarketing pendientes cancelados (sin envío previo, flag no tocado) cliente=${id_cliente}`,
      );
    }
  } catch (err) {
    await log(`⚠️ Error cancelando remarketing: ${err.message}`);
  }
}

// ══════════════════════════════════════════════════════════════
// programarRemarketingKanban
// Se llama SIEMPRE después de procesar el mensaje (con o sin IA)
// ══════════════════════════════════════════════════════════════
async function programarRemarketingKanban({
  id_configuracion,
  id_cliente,
  telefono,
  estado_contacto,
  // Valores del body de la plantilla, YA resueltos. Se reciben aquí porque
  // quien agenda (p. ej. el notifier de Dropi) tiene el pedido a la vista;
  // el cron dispara horas después, cuando ese contexto ya no existe.
  // Array de strings en el orden de {{1}}, {{2}}, {{3}}…
  template_parameters = null,
}) {
  try {
    // 🚫 Verificar si el cliente tiene el remarketing desactivado
    const [clienteRM] = await db.query(
      `SELECT enviar_remarketing FROM clientes_chat_center WHERE id = ? LIMIT 1`,
      { replacements: [id_cliente], type: db.QueryTypes.SELECT },
    );

    const persistente = COLUMNAS_SEGUIMIENTO_PERSISTENTE.has(estado_contacto);

    if (clienteRM && Number(clienteRM.enviar_remarketing) === 0) {
      if (!persistente) {
        await log(
          `🚫 SKIP programarRemarketing — cliente=${id_cliente} tiene enviar_remarketing=0`,
        );
        return;
      }
      // Columna de seguimiento persistente: hay que volver a encenderlo. Lo
      // apagó cancelarRemarketingKanban hace un instante, al ver que el cliente
      // respondía a un recordatorio ya enviado — y el cron descarta las filas de
      // clientes con el flag en 0, así que sin esto el seguimiento moriría con
      // la primera respuesta, incluso si fue "mañana paso a retirarlo".
      await db.query(
        `UPDATE clientes_chat_center SET enviar_remarketing = 1 WHERE id = ?`,
        { replacements: [id_cliente], type: db.QueryTypes.UPDATE },
      );
      await log(
        `🔁 enviar_remarketing reactivado (columna persistente "${estado_contacto}") cliente=${id_cliente}`,
      );
    }

    const [configRM] = await db.query(
      `SELECT tiempo_espera_horas, tiempo_espera_minutos, nombre_template, language_code,
              estado_destino, header_format, header_media_url,
              header_media_name, header_parameters,
              id_template_rapido, usar_respuesta_rapida,
              metodo_dentro_24h, prompt_ia
       FROM configuracion_remarketing
       WHERE id_configuracion = ? AND estado_contacto = ? AND secuencia = 1 AND activo = 1
       LIMIT 1`,
      {
        replacements: [id_configuracion, estado_contacto],
        type: db.QueryTypes.SELECT,
      },
    );

    if (!configRM) return;

    // Si quien reagenda no trae parámetros (el bot, que no conoce el pedido)
    // se heredan los del último pendiente de ESTA MISMA columna. Sin esto, una
    // respuesta del cliente en la columna de agencia reinicia la secuencia sin
    // nombre/agencia/guía, y Meta rechaza el siguiente envío por número de
    // parámetros (132000).
    //
    // NO se filtra por enviado/cancelado a propósito: el webhook llama a
    // cancelarRemarketingKanban ANTES de reprogramar, así que para cuando se
    // llega aquí la fila que tiene los datos ya quedó en cancelado=1 —
    // filtrarla dejaría el heredado siempre en null.
    //
    // Sí se filtra por columna: cada secuencia usa su propia plantilla y
    // heredar los parámetros de otra rompería igual el conteo de variables.
    // La ventana evita revivir datos de un pedido viejo (guía ya entregada).
    let paramsHeredados = null;
    if (!Array.isArray(template_parameters) || !template_parameters.length) {
      const [previo] = await db.query(
        `SELECT template_parameters FROM remarketing_pendientes
          WHERE id_cliente_chat_center = ? AND id_configuracion = ?
            AND estado_contacto_origen = ?
            AND template_parameters IS NOT NULL
            AND creado_en > NOW() - INTERVAL 30 DAY
          ORDER BY id DESC LIMIT 1`,
        {
          replacements: [id_cliente, id_configuracion, estado_contacto],
          type: db.QueryTypes.SELECT,
        },
      );
      paramsHeredados = previo?.template_parameters || null;
    }

    await db.query(
      `UPDATE remarketing_pendientes
       SET cancelado = 1
       WHERE id_cliente_chat_center = ?
         AND id_configuracion = ?
         AND enviado = 0
         AND cancelado = 0`,
      {
        replacements: [id_cliente, id_configuracion],
        type: db.QueryTypes.UPDATE,
      },
    );

    const [cfg] = await db.query(
      `SELECT telefono FROM configuraciones WHERE id = ? LIMIT 1`,
      { replacements: [id_configuracion], type: db.QueryTypes.SELECT },
    );

    const telefono_configuracion = cfg?.telefono ? String(cfg.telefono) : null;
    if (!telefono_configuracion) return;

    const minutos =
      configRM.tiempo_espera_minutos != null
        ? Number(configRM.tiempo_espera_minutos)
        : Number(configRM.tiempo_espera_horas || 0) * 60;

    const tiempoDisparo = new Date(Date.now() + minutos * 60 * 1000);

    const headerMediaUrl = configRM.header_media_url
      ? configRM.header_media_url.replace(/&amp;/g, '&')
      : null;

    await db.query(
      `INSERT INTO remarketing_pendientes
       (telefono, telefono_configuracion, id_cliente_chat_center,
        id_configuracion, estado_contacto_origen, nombre_template,
        language_code, tiempo_disparo, estado_destino,
        header_format, header_media_url, header_media_name, header_parameters,
        id_template_rapido, usar_respuesta_rapida,
        metodo_dentro_24h, prompt_ia, template_parameters,
        enviado, cancelado, secuencia)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 1)`,
      {
        replacements: [
          telefono,
          telefono_configuracion,
          id_cliente,
          id_configuracion,
          estado_contacto,
          configRM.nombre_template,
          configRM.language_code,
          tiempoDisparo,
          configRM.estado_destino || null,
          configRM.header_format || null,
          headerMediaUrl,
          configRM.header_media_name || null,
          configRM.header_parameters || null,
          configRM.id_template_rapido || null,
          configRM.usar_respuesta_rapida ? 1 : 0,
          configRM.metodo_dentro_24h || 'ninguno',
          configRM.prompt_ia || null,
          Array.isArray(template_parameters) && template_parameters.length
            ? JSON.stringify(template_parameters.map((v) => String(v ?? '')))
            : paramsHeredados,
        ],
        type: db.QueryTypes.INSERT,
      },
    );
    await log(
      `📅 Remarketing programado en ${minutos}min — estado=${estado_contacto} método=${configRM.metodo_dentro_24h || 'ninguno'}`,
    );
  } catch (err) {
    await log(`⚠️ Error programando remarketing: ${err.message}`);
  }
}

module.exports = {
  procesarMensajeKanban,
  cancelarRemarketingKanban,
  programarRemarketingKanban,
  // Exportados para reutilizar la generación IA desde el remarketing de IG
  // (no cambian el comportamiento de WhatsApp; son helpers puros de OpenAI).
  ejecutarAsistente,
  ejecutarConResponsesAPI,
  // Lo usa el cron de remarketing: los mensajes que redacta con el asistente de
  // una columna pueden traer tags de acción, y ahí nadie los interpretaba ni los
  // limpiaba (ver cron/remarketing.js → generarMensajeRemarketingIA).
  limpiarTagsAcciones,
  // Expuesta para poder verificar el agendamiento sin levantar toda la
  // conversación: es el camino donde una falla no se ve (la tarjeta se mueve
  // igual aunque la cita no se cree).
  procesarAgendarCita,
  // Expuesta para la batería de regresión: que un cierre con placeholders no
  // cuente como venta es una garantía que no puede perderse en silencio.
  motivoCierreInvalido,
};
