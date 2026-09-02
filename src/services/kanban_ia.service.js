// services/kanban_ia.service.js
// Función genérica que reemplaza todo el switch ventas/eventos/imporfactory.
// Lee el assistant_id y las acciones desde kanban_columnas + kanban_acciones,
// ejecuta el asistente OpenAI y procesa todas las acciones configuradas.
// ─────────────────────────────────────────────────────────────

const axios = require('axios');
const flatted = require('flatted');
const { db } = require('../database/config');
const { verificarAccesoAutomatizaciones } = require('../utils/planAcceso');
const { botApagadoExplicito } = require('../utils/interruptorBot');
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

// Un turno de OpenAI a la vez por cliente: los huecos >8s que la ráfaga ya no
// agrupa corrían en paralelo y bifurcaban la cadena de previous_response_id
// (ver el encabezado de utils/turnoPorCliente.js).
const { tomarTurnoCliente } = require('../utils/turnoPorCliente');

// Ficha del pedido: lo que el CLIENTE ya dijo, leído de mensajes_clientes.
// Se le dicta al modelo (no repreguntar), completa el resumen de cierre cuando
// el modelo omite un dato que el cliente sí dio, y detecta el cierre narrado
// sin tag (ver el encabezado de utils/fichaPedido.js).
const {
  extraerFichaPedido,
  bloqueFichaPedido,
  completarResumenConFicha,
  esCierreNarrado,
  pareceResumenDePedido,
  nombrePaisDe,
  aparecioEnCliente,
  ciudadAproxEnCliente,
} = require('../utils/fichaPedido');

// ¿Qué producto del catálogo nombra un texto? Compartido por el enrutado a
// venta_producto y el adjunto de la foto del producto (ver su encabezado).
const { productoNombrado } = require('../utils/productoNombrado');

// Ubicación compartida por WhatsApp → dirección/ciudad/provincia en palabras
const {
  parseUbicacionJson,
  reverseGeocode,
} = require('../utils/geoUbicacion');

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

    /* Un reinicio manual (eliminar_thread desde el chat) significa "arranca de
       cero": el recap no puede volver a mostrarle al modelo la conversación
       que se acaba de descartar. Sin este corte, el reinicio borraba la cadena
       en OpenAI pero la siembra la reconstruía enterita desde
       mensajes_clientes — con los vicios del prompt anterior incluidos (caso
       569 del 2026-08-18: el prompt nuevo prohibía los resúmenes parciales y
       el bot los seguía escribiendo porque imitaba su propio historial
       re-sembrado). La columna viene de una migración manual
       (reinicio_conversacion_migration.sql): si no está aplicada, se sigue
       sin corte, como siempre. */
    let desdeReinicio = null;
    try {
      const [cli] = await db.query(
        `SELECT reinicio_conversacion_at FROM clientes_chat_center
          WHERE id = ? LIMIT 1`,
        { replacements: [id_cliente], type: db.QueryTypes.SELECT },
      );
      desdeReinicio = cli?.reinicio_conversacion_at || null;
    } catch (_) {}

    const rows = await db.query(
      `SELECT rol_mensaje, texto_mensaje
         FROM mensajes_clientes
        WHERE celular_recibe = ?
          AND texto_mensaje IS NOT NULL
          AND texto_mensaje <> ''
          AND deleted_at IS NULL
          ${desdeReinicio ? 'AND created_at > ?' : ''}
        ORDER BY id DESC
        LIMIT ${limite}`,
      {
        replacements: desdeReinicio
          ? [String(id_cliente), desdeReinicio]
          : [String(id_cliente)],
        type: db.QueryTypes.SELECT,
      },
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

   Dos familias de señales:
   1. Plantilla copiada: corchetes tipo "[nombre completo real]" —quitando
      antes los tags del sistema y de media, que también usan corchetes— y las
      frases de relleno que el arnés de prompts ya cazaba en las pruebas.
   2. Resumen incompleto. La versión anterior solo validaba las líneas que
      EXISTÍAN, y el modo de fallo real de la 285 (2026-08-19) fue omitirlas:
      un cierre con solo Cantidad/Precio/Producto pasó limpio ("¿Si sabe a
      dónde enviarlo???", preguntó el cliente), y otro cerró con "📍 Ciudad:
      (necesito que me digas la ciudad)" — relleno entre paréntesis que la
      blacklist de frases no veía. El extractor del auto-orden no puede
      rescatar lo que el cliente nunca dijo, así que esas órdenes caían a
      manual o, peor, subían con datos inventados.

   Devuelve el motivo, o null si el cierre es válido. */
const RE_TAGS_SISTEMA = /\[[a-z_]+\]\s*:\s*(?:true|false)/gi;
const RE_TAGS_MEDIA =
  /\[(?:producto|servicio|upsell)_(?:imagen|video)_url\]\s*:[^\n]*/gi;

/* ¿Este valor es el bot pidiendo el dato dentro del propio resumen, en vez de
   traerlo? Se detecta por FORMA (corchetes, paréntesis que envuelven todo el
   valor) y por palabras de pedido, no por frases exactas: cada cuenta lo
   redacta distinto y una blacklist de frases siempre corre por detrás —
   "(necesito que me digas la ciudad)" y "(si aplica)" pasaron limpias. */
function esValorRelleno(valor) {
  const t = String(valor || '')
    .replace(/[*_]/g, '')
    .trim();
  if (!t) return true;
  if (/[\[\]]/.test(t)) return true;
  if (/^\(.+\)$/.test(t)) return true;
  return /necesito|ind[ií]ca|ind[ií]que|proporcion|por favor|pendiente|falta|\bdime\b|d[ií]game|seg[uú]n tu elecci[oó]n|no registra/i.test(
    t,
  );
}

/* Campos del resumen de cierre — los mismos rótulos que extrae el auto-orden.
   Devuelve la lista de lo que FALTA (línea ausente o de relleno), redactada
   lista para pedírsela al cliente. La usan el candado del paso 10 (decidir si
   el cierre se bloquea) y el paso 12 (redactar la petición): un solo criterio,
   o el candado bloquearía por una cosa y la petición pediría otra.

   El teléfono NO se exige presente a propósito: si la línea no vino, el
   auto-orden usa el número desde el que la persona escribe (pedirle su número
   a quien te está escribiendo por WhatsApp es el tic absurdo que contextoColumna
   ya corrigió). Pero si la línea vino, tiene que ser un número real — caso 569:
   "📞 Teléfono: 09XXXXXXXX (a confirmar)". */
/* Prefijo de la petición de datos que el paso 12 manda cuando bloquea un
   cierre. Es también la huella con la que el paso 6.7 detecta "el turno
   anterior fue un cierre bloqueado" leyendo mensajes_clientes: si cambias
   este texto, cambia en los dos lados o el rescate deja de funcionar. */
const PREFIJO_PETICION_DATOS = 'Para confirmar tu pedido, ayúdame con';

/* `ficha` (opcional) es la ficha del pedido de utils/fichaPedido: trae
   `_textoCliente` (lo que escribió el cliente). Con ella se aplica el candado
   ANTI-INVENTO: una ciudad o un teléfono que aparecen en el resumen pero que
   el cliente nunca escribió los puso el modelo (caso real 2026-08-20, cfg
   610/10: el bot "cerró" con "Ciudad: Quito, Provincia: Pichincha" sin que el
   cliente dijera su ciudad). Se tratan como faltantes: se bloquea el cierre y
   se le pide el dato. Sin ficha, el comportamiento es el de siempre. */
function camposFaltantesCierre(respuesta, ficha = null) {
  const textoCliente = String(ficha?._textoCliente || '');
  const dichoPorCliente = (valor, opts) =>
    !textoCliente || aparecioEnCliente(valor, textoCliente, opts);
  const texto = String(respuesta || '')
    .replace(RE_TAGS_SISTEMA, '')
    .replace(RE_TAGS_MEDIA, '');
  // null = la línea no existe en el resumen (distinto de existir vacía)
  const campo = (re) => {
    const m = texto.match(re)?.[1];
    return m === undefined ? null : m.replace(/[*_]/g, '').trim();
  };

  /* ⚠️ Los rótulos se buscan al inicio de la línea con hasta 6 caracteres de
     adorno antes (emoji, asteriscos, guión) y SIN el emoji dentro del regex.
     El patrón viejo /🧑?\s*Nombre:/ parecía hacer el emoji opcional, pero sin
     el flag `u` el `?` aplica solo a la SEGUNDA mitad del surrogate pair: la
     primera mitad quedaba OBLIGATORIA, y cualquier resumen con otro adorno
     ("🧑 *Nombre:* Rosa", "📍 *Agencia de retiro:* …") no matcheaba NINGÚN
     campo. El validador creía que faltaba todo, bloqueaba el cierre y le
     pedía los datos una y otra vez a una clienta que ya los había dado
     (caso 666, Rosy, 2026-08-19: la venta la terminó rescatando una humana).
     El ancla de línea es a propósito: sin ella, "Nombre del producto:" o un
     "producto:" a mitad de frase contarían como rótulos. */
  const nombre = campo(
    /(?:^|\n)[^\n]{0,6}?Nombre(?:\s+completo)?\s*:\s*([^\n]+)/i,
  );
  const telefono = campo(/(?:^|\n)[^\n]{0,6}?Tel[eé]fono\s*:\s*([^\n]+)/i);
  const ciudad = campo(/(?:^|\n)[^\n]{0,6}?Ciudad\s*:\s*([^\n]+)/i);
  const direccion = campo(
    /(?:^|\n)[^\n]{0,6}?Direcci[oó]n[^:\n]{0,25}:\s*([^\n]+)/i,
  );
  const agencia = campo(/(?:^|\n)[^\n]{0,6}?Agencia[^:\n]*:\s*([^\n]+)/i);

  const faltan = [];

  /* Un nombre de UNA palabra no genera guía (falta el apellido) y todos los
     prompts lo exigen en dos. */
  if (nombre === null || esValorRelleno(nombre) || !/\s/.test(nombre)) {
    faltan.push('- Nombre completo');
  }

  if (telefono !== null) {
    const digitos = (telefono.match(/\d/g) || []).length;
    if (
      esValorRelleno(telefono) ||
      /x{2,}/i.test(telefono) ||
      /confirmar/i.test(telefono) ||
      digitos < 9 ||
      // Anti-invento: un número que el cliente nunca escribió.
      !dichoPorCliente(telefono.replace(/\D/g, ''), { esTelefono: true })
    ) {
      faltan.push('- Teléfono');
    }
  }

  /* Anti-invento de la ciudad: si la línea trae una ciudad que el cliente no
     escribió, vale tanto como si faltara (y es peor: la guía saldría a otra
     parte). Se pide aunque haya dirección. */
  /* El typo del cliente no es invento: "Guayuquil" en sus palabras valida la
     línea "Ciudad: Guayaquil" del resumen (la ficha ya la corrige a la ciudad
     real para el auto-orden). Caso UP NOW 2026-09-01: la ciudad corregida no
     coincidía literal y el bot re-pedía la ciudad que ya le habían dado. */
  const ciudadInventada =
    ciudad !== null &&
    !esValorRelleno(ciudad) &&
    Boolean(textoCliente) &&
    !dichoPorCliente(ciudad) &&
    !ciudadAproxEnCliente(ciudad, textoCliente);
  if (ciudadInventada) {
    faltan.push('- Ciudad y provincia');
  } else if (ciudad === null || esValorRelleno(ciudad)) {
    /* Caso real (302, 2026-08-19, Carmen): la clienta dio "Provincia
       Tungurahua Canton Quero avenida 17 de abril..." y el modelo fundió
       ciudad y provincia dentro de la línea Dirección, sin escribir la línea
       "Ciudad:". Este candado bloqueaba ese cierre —con todos los datos
       reales a la vista— y de ahí en adelante la venta quedaba muerta (ver
       paso 6.7). Con una Dirección REAL la falta de la línea Ciudad no
       bloquea: la ciudad suele venir dentro de la dirección, y quien la
       necesita exacta es el auto-orden, que la extrae de los mensajes DEL
       CLIENTE y tiene su propio candado anti-invento. Si tampoco hay
       dirección concreta (relleno o "por confirmar"), se sigue exigiendo:
       ahí nadie más la rescata. */
    const direccionReal =
      direccion !== null &&
      !esValorRelleno(direccion) &&
      !/por confirmar/i.test(direccion);
    /* Con una AGENCIA concreta pasa lo mismo que con la dirección: la línea
       ya dice dónde ("Agencia de retiro: Servientrega Tumbaco" — caso 666,
       Rosy) y la ciudad exacta la extrae el auto-orden de los mensajes del
       cliente. Solo la agencia "por confirmar" sigue exigiendo ciudad: ahí
       es el único dato de destino que existe. */
    const agenciaReal =
      agencia !== null &&
      !esValorRelleno(agencia) &&
      !/por confirmar/i.test(agencia);
    if (!direccionReal && !agenciaReal) faltan.push('- Ciudad y provincia');
  }

  /* La entrega puede ser a domicilio (🏡 Direccion) o retiro en agencia
     (🏦 Agencia). "Por confirmar" es legítimo SOLO en estas dos líneas:
     la agencia por confirmar del flujo 7.4 cierra así a propósito. */
  const entregaOk = (v) =>
    v !== null && (/por confirmar/i.test(v) || !esValorRelleno(v));
  if (!entregaOk(direccion) && !entregaOk(agencia)) {
    faltan.push(
      '- Dirección exacta (dos calles y una referencia), o la agencia ' +
        'Servientrega si prefieres retirarlo',
    );
  }

  return faltan;
}

/* ── Resumen con VARIOS productos ──
   Cuando el pedido lleva más de un producto distinto, contextoColumna le
   dicta al bot escribir UNA línea "📦 Producto:" por cada uno, con este
   formato:
     📦 Producto: <nombre> x<cantidad> (Variedad: <la elegida>)
   Esta función devuelve esos renglones parseados, o [] si el resumen trae
   una sola línea de producto — el caso de siempre, donde nada cambia. El
   auto-orden recibe la lista en datosBot.productos y sube la orden con
   todos los renglones (Dropi la acepta si salen de la misma bodega). */
function parsearProductosResumen(respuesta) {
  /* Mismo criterio que camposFaltantesCierre: rótulo al inicio de línea con
     hasta 6 caracteres de adorno, sin emoji en el regex (el "📦?" viejo hacía
     el emoji OBLIGATORIO por el surrogate pair, y un resumen "- *Producto:*"
     no parseaba). El ancla evita que un "Nombre del producto:" a mitad de
     frase cuente como renglón fantasma. */
  const lineas = [
    ...String(respuesta || '').matchAll(
      /(?:^|\n)[^\n]{0,6}?Producto\s*:\s*([^\n]+)/gi,
    ),
  ].map((m) => m[1].trim());
  if (lineas.length < 2) return [];

  return lineas.map((linea) => {
    let txt = linea;
    const variedad =
      txt
        .match(/\(?\s*(?:Variedad|Variante|Color|Talla):\s*([^)\n]+)\)?/i)?.[1]
        ?.trim() || '';
    txt = txt
      .replace(/\(?\s*(?:Variedad|Variante|Color|Talla):\s*[^)\n]*\)?/i, '')
      .trim();
    // Cantidad: "… x2" al final (el formato dictado) o "2 x …" al inicio
    // (como lo escriben algunos bots por su cuenta).
    const alFinal = txt.match(/\bx\s*(\d+)\s*$/i);
    const alInicio = txt.match(/^(\d+)\s*x\s+/i);
    const cantidad = alFinal?.[1] || alInicio?.[1] || '1';
    txt = txt
      .replace(/\bx\s*\d+\s*$/i, '')
      .replace(/^\d+\s*x\s+/i, '')
      .replace(/[*_]/g, '')
      .replace(/[—–,-]\s*$/, '')
      .trim();
    return { producto: txt, cantidad, variedad };
  });
}

function motivoCierreInvalido(respuesta, ficha = null) {
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

  /* Completitud. Solo se exige cuando la respuesta SE PARECE al resumen
     estándar (trae algún rótulo conocido): si una cuenta usa otro formato de
     cierre, bloquearle todos los cierres la dejaría sin ventas — ahí la red
     sigue siendo el candado de datos del propio auto-orden. */
  const pareceResumen =
    /(?:Nombre|Tel[eé]fono|Ciudad|Direcci[oó]n|Producto|Cantidad|Precio)\s*:/i.test(
      texto,
    );
  if (pareceResumen) {
    const faltan = camposFaltantesCierre(respuesta, ficha);
    if (faltan.length) {
      return (
        'resumen incompleto o con relleno: falta ' +
        faltan.map((f) => f.replace(/^- /, '').toLowerCase()).join(' | ')
      );
    }
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
    enviarTexto: async ({ texto, responsable, total_tokens, analytics }) =>
      enviarMensajeWhatsapp({
        phone_whatsapp_to: telefono,
        texto_mensaje: texto,
        business_phone_id,
        accessToken,
        id_configuracion,
        responsable,
        total_tokens,
        analytics,
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
  // Modelo y desglose de tokens de la respuesta (para el panel de consumo).
  let analyticsIA = null;
  /* Una ubicación compartida por WhatsApp se guarda como el JSON crudo que
     manda Meta (`{"latitude":-0.3,"longitude":-78.4}`) porque así lo pinta el
     chat. Al asistente le llegaba eso literal y contestaba lo que se puede
     esperar de alguien que recibe un JSON: pedía la dirección "en palabras".
     Y en captación —donde al propietario se le PIDE que mande la ubicación—
     eso es quedarse sin el dato justo después de conseguirlo.
     Se traduce solo para el modelo; lo guardado no se toca. */
  const textoDelSistema =
    (await textoDeUbicacion(mensaje)) || textoDeMensajeIlegible(mensaje);

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
          /* Decirlo EXPLÍCITO, no omitir el bloque: el prompt de esta columna
             gira alrededor de confirmar un pedido, y ante el silencio el
             modelo asumía uno del catálogo y "confirmaba" un producto que la
             persona jamás compró (escriben desde otro número, o los movieron
             a mano a la columna). Una línea de contexto evita el peor error
             posible. */
          bloqueContexto +=
            `📦 SIN PEDIDO REGISTRADO PARA ESTE NÚMERO: se buscó por su ` +
            `teléfono entre las órdenes pendientes de confirmación y no hay ` +
            `ninguna.\n` +
            `NO asumas ni inventes qué compró, ni "confirmes" ningún ` +
            `producto ni des datos de un pedido — no existe ninguno a la ` +
            `vista. Pregúntale qué producto le interesa, o si dice que ya ` +
            `hizo un pedido, pídele el teléfono con el que lo hizo (puede ` +
            `estar escribiendo desde otro número).\n\n`;
          await log(
            `ℹ️ Sin orden PENDIENTE CONFIRMACION en cache cliente=${id_cliente} — contexto "sin pedido" inyectado`,
          );
        }
      }
    } catch (e) {
      await log(`⚠️ Error inyectando contexto orden Dropi: ${e.message}`);
    }
  }

  // ── 6.6 Retiro en agencia: el plazo que la tienda comunica ──
  // El prompt de esa columna prohíbe inventar plazos, así que "¿hasta cuándo
  // lo guardan?" terminaba SIEMPRE en asesor — pudiendo responderse con el
  // dato que la propia cuenta configuró (configuraciones.dias_retiro_agencia,
  // el mismo que sale en las plantillas k1/k2/k3 y en los prompts del cron de
  // remarketing). Scopeado a esta columna a propósito: en el resto del
  // tablero el plazo no significa nada y sería ruido en cada mensaje.
  if (String(estado_contacto).toLowerCase() === 'retiro_agencia') {
    try {
      const [cfgPlazo] = await db.query(
        `SELECT dias_retiro_agencia FROM configuraciones WHERE id = ? LIMIT 1`,
        { replacements: [id_configuracion], type: db.QueryTypes.SELECT },
      );
      const diasPlazo = Number(cfgPlazo?.dias_retiro_agencia) || 0;
      if (diasPlazo > 0) {
        bloqueContexto +=
          `⏳ PLAZO DE RETIRO EN AGENCIA: ${diasPlazo} día${diasPlazo === 1 ? '' : 's'}.\n` +
          `Si preguntan cuánto tiempo guardan el paquete o hasta cuándo pueden ` +
          `retirarlo, responde con ESTE plazo — es el que la tienda comunica en ` +
          `todos sus mensajes. Cumplido el plazo, el paquete regresa al ` +
          `remitente; no ofrezcas extenderlo ni ninguna otra alternativa.\n\n`;
        await log(`⏳ Plazo de retiro inyectado: ${diasPlazo} día(s)`);
      }
    } catch (e) {
      await log(`⚠️ Error inyectando plazo de retiro: ${e.message}`);
    }

    /* Dónde retirar. La orden del cache trae en `dir` lo que el vendedor
       escribió al crearla; si Servientrega desvió el envío a una agencia,
       eso es la CASA del cliente (cfg 889, orden 6612199). Se le da al bot el
       lugar resuelto (utils/lugarRetiroAgencia: agencia real guardada por el
       notifier, o `dir` si es agencia, o "agencia Servientrega en {ciudad}").
       Sin red en el turno: si aún no está guardada se dispara en segundo
       plano y la toma el siguiente mensaje. */
    try {
      const {
        resolverLugarRetiro,
        completarAgenciaEnBackground,
      } = require('../utils/lugarRetiroAgencia');
      const tel9 = String(telefono || '')
        .replace(/\D/g, '')
        .slice(-9);
      if (tel9.length >= 9) {
        const [ord] = await db.query(
          `SELECT dropi_order_id, city, shipping_company, shipping_guide, order_data
             FROM dropi_orders_cache
            WHERE id_configuracion = ?
              AND RIGHT(REGEXP_REPLACE(phone, '[^0-9]', ''), 9) = ?
              AND classified_status = 'retiro_agencia'
            ORDER BY order_created_at DESC LIMIT 1`,
          {
            replacements: [id_configuracion, tel9],
            type: db.QueryTypes.SELECT,
          },
        );
        if (ord) {
          let od = {};
          try {
            od = JSON.parse(ord.order_data || '{}') || {};
          } catch (_) {}
          const order = {
            id: ord.dropi_order_id,
            dir: od.dir || '',
            city: ord.city || od.city || '',
            country: od.country || '',
            shipping_company: ord.shipping_company || od.shipping_company,
            shipping_guide: ord.shipping_guide || od.shipping_guide,
          };
          const retiro = await resolverLugarRetiro({
            order,
            consultar: false,
          });
          if (!retiro.agencia) completarAgenciaEnBackground({ order });
          bloqueContexto +=
            `📍 LUGAR DE RETIRO DEL PAQUETE: ${retiro.lugar}` +
            (order.shipping_guide ? ` · Guía ${order.shipping_guide}` : '') +
            `.\n` +
            `Si preguntan dónde retirar, responde con ESTE lugar. La dirección ` +
            `del pedido${order.dir ? ` ("${String(order.dir).slice(0, 80)}")` : ''} ` +
            `es el domicilio que se registró al comprar, NO el lugar de retiro: ` +
            `no la des como agencia.` +
            (retiro.fuente === 'ciudad'
              ? ` No se conoce la agencia exacta: dile que es la agencia de ` +
                `Servientrega de su ciudad y que puede confirmarla con su guía ` +
                `en el tracking.`
              : '') +
            `\n\n`;
          await log(`📍 Lugar de retiro inyectado (${retiro.fuente})`);
        } else {
          /* Mismo principio que en pendiente confirmación: sin orden a la
             vista, decirlo — omitir el bloque dejaba al modelo libre de
             inventar una agencia o una guía. */
          bloqueContexto +=
            `📍 SIN ORDEN EN RETIRO EN AGENCIA PARA ESTE NÚMERO: se buscó ` +
            `por su teléfono y no hay ninguna.\n` +
            `NO inventes agencia, guía ni estado del envío. Si pregunta por ` +
            `un paquete, pídele el teléfono con el que hizo el pedido o su ` +
            `número de guía.\n\n`;
          await log(
            `ℹ️ Sin orden retiro_agencia en cache — contexto "sin orden" inyectado`,
          );
        }
      }
    } catch (e) {
      await log(`⚠️ Error inyectando lugar de retiro: ${e.message}`);
    }
  }

  // ── 6.7 Cierre bloqueado en el turno anterior: rescatarlo ──
  /* Cuando el paso 10 bloquea un cierre (resumen incompleto), el paso 12 le
     manda al cliente la petición de datos — pero el mensaje ORIGINAL del
     modelo (resumen + tag) queda en el thread/cadena, así que para el modelo
     la venta YA se cerró: al siguiente mensaje repite el cierre SIN el tag,
     el trigger nunca coincide y el cliente se queda clavado en la columna
     (caso 302, Carmen, 2026-08-19: compró, el cierre quedó bloqueado por la
     línea Ciudad, y una hora después el cron de remarketing le escribió como
     si no hubiera comprado).
     El estado "hubo un cierre bloqueado" no se guarda en ningún lado, pero la
     petición del paso 12 SÍ quedó en mensajes_clientes con un texto que solo
     escribe el código (PREFIJO_PETICION_DATOS): esa es la marca. Se mira solo
     en los últimos mensajes del bot para que la nota decaiga sola si la
     conversación siguió por otro lado.
     La nota va como contexto del turno (nada de tocar prompts): re-emitir el
     resumen completo CON el tag, sin volver a preguntar nada que el cliente
     ya dio — el interrogatorio repetido es justo la enfermedad que ya se curó
     una vez en contextoColumna. */
  /* Cuántas peticiones del paso 12 ya se mandaron (misma ventana de 10):
     la usa el paso 12 para NO repetir la misma petición una tercera vez —
     al tercer cierre bloqueado consecutivo escala a asesor (caso 495, Iván:
     4 peticiones idénticas seguidas → "ya no las necesito", venta muerta). */
  let peticionesCierrePrevias = 0;
  // Últimos mensajes salientes (IA y personas): los usan el 6.7, el 6.8 y la
  // detección del cierre narrado. Se declara afuera para no consultarlos tres
  // veces.
  let ultimosBot = [];
  const accCierreVenta = getAcciones('cambiar_estado')
    .map((ac) => parseConfig(ac))
    .find((c) => c.estado_destino === 'generar_guia' && c.trigger);

  /* ÚLTIMO MENSAJE = REMARKETING → inyectarlo SIEMPRE (independiente del
     cierre de venta). Con la Responses API el remarketing se genera leyendo
     la cadena pero SIN escribirla (a propósito: encadenarlo la infla hasta
     reventar), así que el modelo NO recuerda lo último que le dijo al
     cliente. Caso cfg 277 (Felipe, 2026-08-26): el remarketing decía "tu
     pedido está empacado, listo para salir", el cliente preguntó "¿cuál es
     mi guía?" y el bot —ciego a su propio mensaje— interpretó "guía" como
     directriz y le respondió con sus reglas internas. */
  if (USAR_RESPONSES_API) {
    try {
      const [ultimoMsg] = await db.query(
        `SELECT texto_mensaje, responsable, created_at FROM mensajes_clientes
          WHERE celular_recibe = ? AND id_configuracion = ?
            AND rol_mensaje = 1 AND deleted_at IS NULL
            AND tipo_mensaje IN ('text', 'template')
          ORDER BY id DESC LIMIT 1`,
        {
          replacements: [id_cliente, id_configuracion],
          type: db.QueryTypes.SELECT,
        },
      );
      const hace48h = Date.now() - 48 * 60 * 60 * 1000;
      if (
        ultimoMsg &&
        /^cron_remarketing/i.test(String(ultimoMsg.responsable || '')) &&
        String(ultimoMsg.texto_mensaje || '').trim() &&
        new Date(ultimoMsg.created_at).getTime() >= hace48h
      ) {
        bloqueContexto +=
          `🕐 TU ÚLTIMO MENSAJE AL CLIENTE fue este recordatorio automático (lo envió el sistema en tu nombre y NO está en tu memoria):\n` +
          `"${String(ultimoMsg.texto_mensaje).trim().slice(0, 500)}"\n` +
          `El cliente está respondiendo a ESO: interpreta su mensaje en ese contexto (si pregunta por "mi guía", "mi pedido" o "el envío", habla de SU pedido — nunca respondas con tus reglas internas ni menciones "flujo", "instrucciones" o "mensajes anteriores").\n\n`;
        await log(
          `🕐 Último mensaje fue remarketing (${ultimoMsg.responsable}): inyectado como contexto cliente=${id_cliente}`,
        );
      }
    } catch (e) {
      await log(`⚠️ Error inyectando remarketing previo: ${e.message}`);
    }
  }

  if (accCierreVenta) {
    try {
      /* Mismo corte que el recap y la ficha: después de "Reiniciar
         conversación" no cuentan ni la petición de datos, ni el cierre
         narrado, ni los mensajes del asesor de la conversación anterior. */
      let desdeReinicio = null;
      try {
        const [cliR] = await db.query(
          `SELECT reinicio_conversacion_at FROM clientes_chat_center
            WHERE id = ? LIMIT 1`,
          { replacements: [id_cliente], type: db.QueryTypes.SELECT },
        );
        desdeReinicio = cliR?.reinicio_conversacion_at || null;
      } catch (_) {}
      ultimosBot = await db.query(
        `SELECT texto_mensaje, responsable, created_at FROM mensajes_clientes
          WHERE celular_recibe = ? AND id_configuracion = ?
            AND rol_mensaje = 1 AND deleted_at IS NULL
            AND tipo_mensaje = 'text'
            ${desdeReinicio ? 'AND created_at > ?' : ''}
          ORDER BY id DESC LIMIT 10`,
        {
          replacements: desdeReinicio
            ? [id_cliente, id_configuracion, desdeReinicio]
            : [id_cliente, id_configuracion],
          type: db.QueryTypes.SELECT,
        },
      );
      const peticiones = ultimosBot.filter((m) =>
        String(m.texto_mensaje || '').startsWith(PREFIJO_PETICION_DATOS),
      );
      peticionesCierrePrevias = peticiones.length;
      const peticion = peticiones[0]; // la más reciente (orden DESC)
      if (peticion) {
        const faltaba = String(peticion.texto_mensaje)
          .split('\n')
          .slice(1)
          .map((l) => l.trim())
          .filter((l) => l.startsWith('- '))
          .map((l) => l.replace(/^- /, ''))
          .join(' | ');
        bloqueContexto +=
          `⚠️ CIERRE PENDIENTE: tu último resumen de cierre fue RECHAZADO por el sistema porque estaba incompleto` +
          (faltaba ? ` (faltaba: ${faltaba})` : '') +
          `. La venta NO está cerrada, aunque en la conversación parezca que sí.\n` +
          `En cuanto tengas ese dato —revisa la conversación: es probable que el cliente YA lo haya dado— escribe otra vez el resumen COMPLETO del pedido con TODAS sus líneas y el tag ${accCierreVenta.trigger}, todo en un solo mensaje.\n` +
          `NO le pidas al cliente datos que ya dio, NO le pidas que confirme otra vez si ya confirmó, y NO menciones que hubo un error del sistema.\n\n`;
        await log(
          `🩹 Cierre bloqueado detectado en turno anterior (faltaba: ${faltaba || '?'}): nota de rescate inyectada cliente=${id_cliente}`,
        );
      }
    } catch (e) {
      await log(`⚠️ Error detectando cierre bloqueado previo: ${e.message}`);
    }
  }

  /* ── 6.8 Ficha del pedido + asesor humano + cierre narrado ──
     Todo lo que sigue es código, no prompt: vale igual para todas las cuentas
     con cierre de venta (accCierreVenta). Ver utils/fichaPedido.js.

     a) MENSAJES DE UNA PERSONA DEL NEGOCIO. Cuando un asesor escribe en el
        chat, el modelo no lo ve (la cadena de OpenAI solo lleva lo que este
        código le manda) y lo contradice o repite (caso 360, Delfin: la
        asesora confirmó la agencia y el bot siguió pidiendo "dirección
        exacta"). Se le pasan como contexto para que los tenga en cuenta.

     b) FICHA DEL PEDIDO: lo que el cliente YA dijo, extraído de SUS mensajes
        y verificado contra ellos. Se inyecta solo en la fase de datos (el bot
        ya pidió/mencionó datos, o el mensaje trae uno) para no gastar la
        llamada en el "hola, precio". La ficha también se usa en el paso 10
        para completar el resumen antes de validarlo.

     c) CIERRE NARRADO SIN TAG en el turno anterior: el último mensaje de la
        IA dijo "gracias por tu compra"/"pedido registrado" y, como seguimos en
        esta columna, el sistema NO lo procesó (caso 302, Josué: 4 "resúmenes
        finales" seguidos). Se le dice que la venta NO está cerrada y que
        cierre bien, una sola vez, con el tag. */
  let fichaPedido = null;
  if (accCierreVenta) {
    // a) persona del negocio en el chat (últimas 24 h)
    try {
      const hace24h = Date.now() - 24 * 60 * 60 * 1000;
      const humanos = ultimosBot
        .filter(
          (m) =>
            m.responsable &&
            !/^IA_/i.test(String(m.responsable)) &&
            // Los envíos de los crons (remarketing, programados) NO son una
            // persona del negocio: presentarlos como tal confunde al modelo.
            !/^cron_/i.test(String(m.responsable)) &&
            String(m.texto_mensaje || '').trim() &&
            !String(m.texto_mensaje || '').startsWith(PREFIJO_PETICION_DATOS) &&
            new Date(m.created_at).getTime() >= hace24h,
        )
        .slice(0, 5)
        .reverse();
      if (humanos.length) {
        bloqueContexto +=
          `👩‍💼 UNA PERSONA DEL NEGOCIO TAMBIÉN LE ESCRIBIÓ AL CLIENTE en este chat (tú no escribiste esto):\n` +
          humanos
            .map((m) => `- "${String(m.texto_mensaje).trim().slice(0, 200)}"`)
            .join('\n') +
          `\nTenlo en cuenta: no la contradigas, no repitas lo que ya dijo y no vuelvas a preguntar lo que ella ya resolvió. Si ella ya respondió lo que el cliente preguntó, no lo respondas otra vez.\n\n`;
        await log(
          `👩‍💼 ${humanos.length} mensaje(s) de persona del negocio inyectados como contexto cliente=${id_cliente}`,
        );
      }
    } catch (e) {
      await log(`⚠️ Error inyectando mensajes de asesor: ${e.message}`);
    }

    /* b) ficha del pedido. NO en la columna principal de Dropi (Pendiente
       confirmación): ahí el pedido YA existe y sus datos se inyectan desde la
       orden (6.5); una ficha armada solo con lo que el cliente escribió en
       esta conversación diría "falta nombre" y el bot se lo pediría a quien
       ya compró. */
    try {
      const PIDE_DATOS =
        /nombre|tel[eé]fono|direcci[oó]n|ciudad|provincia|agencia|servientrega|domicilio|referencia|resumen|pedido/i;
      const enFaseDatos =
        ultimosBot.some((m) => PIDE_DATOS.test(String(m.texto_mensaje || ''))) ||
        PIDE_DATOS.test(String(mensaje || '')) ||
        /\d{9,}/.test(String(mensaje || ''));
      if (enFaseDatos && api_key_openai && !columna.es_dropi_principal) {
        const [cfgPais] = await db.query(
          `SELECT pais_plantilla FROM configuraciones WHERE id = ? LIMIT 1`,
          { replacements: [id_configuracion], type: db.QueryTypes.SELECT },
        );
        fichaPedido = await extraerFichaPedido({
          id_configuracion,
          id_cliente,
          api_key_openai,
          paisNombre: nombrePaisDe({
            pais_plantilla: cfgPais?.pais_plantilla,
            telefono,
          }),
          log,
        });
        /* Con el switch de retiro en agencia, la ficha cambia el orden de los
           datos (ciudad → oficina del directorio → nombre) y el formato de la
           línea de dirección — sin el flag, la ficha dictaba "pide el nombre"
           apenas el cliente decía agencia y el cierre "Agencia Servientrega —
           ciudad" sin oficina. */
        let retiroDirectorioFicha = false;
        try {
          const {
            estaActivo: retiroAgenciaActivo,
          } = require('./kanban_retiro_agencia.service');
          retiroDirectorioFicha = await retiroAgenciaActivo(id_configuracion);
        } catch (_) {
          /* sin el service: comportamiento de siempre */
        }
        const bloqueFicha = bloqueFichaPedido(fichaPedido, {
          trigger: accCierreVenta.trigger,
          retiroDirectorio: retiroDirectorioFicha,
        });
        /* Si el último mensaje al cliente lo generó la GUARDIA de oficinas
           (reemplazo en código), el modelo no lo tiene en su memoria: se le
           inyecta igual que el remarketing (caso Felipe 277) para que
           entienda a qué responde el cliente ("la 2", "esa"). */
        if (retiroDirectorioFicha && fichaPedido?.entrega === 'agencia') {
          try {
            const {
              GUARDIA_MARCA_CIUDAD,
              GUARDIA_MARCA_LISTA,
              GUARDIA_MARCA_OFERTA,
            } = require('./kanban_retiro_agencia.service');
            const [ultBot] = await db.query(
              `SELECT texto_mensaje FROM mensajes_clientes
                WHERE id_configuracion = ? AND celular_recibe = ?
                  AND rol_mensaje = 1 AND deleted_at IS NULL
                ORDER BY id DESC LIMIT 1`,
              {
                replacements: [id_configuracion, String(id_cliente)],
                type: db.QueryTypes.SELECT,
              },
            );
            const txtUlt = String(ultBot?.texto_mensaje || '');
            if (
              txtUlt.includes(GUARDIA_MARCA_LISTA) ||
              txtUlt.includes(GUARDIA_MARCA_CIUDAD) ||
              txtUlt.includes(GUARDIA_MARCA_OFERTA) ||
              /retiras en\s+[^\n]{6,}/i.test(txtUlt)
            ) {
              bloqueContexto +=
                `🏦 TU ÚLTIMO MENSAJE AL CLIENTE fue este (lo envió el sistema en tu nombre y NO está en tu memoria):\n` +
                `"${txtUlt.slice(0, 700)}"\n` +
                `El cliente está respondiendo a ESO. Reglas: si dice "la 1", "la 2", "la primera" o un sector, eligió esa oficina de la lista; si el mensaje ofrecía UNA oficina ("¿Retiramos ahí?") y responde "sí", "esa", "dale" u otra afirmación, ESA oficina queda ELEGIDA — es la dirección del pedido, no la vuelvas a preguntar ni ofrezcas otras: confírmala y pide el siguiente dato que falte.\n\n`;
              await log(`🏦 Último mensaje fue de la guardia de oficinas: inyectado como contexto`);
            }
          } catch (_) {
            /* nota opcional: nunca tumba el turno */
          }
        }
        if (bloqueFicha) {
          bloqueContexto += bloqueFicha;
          await log(
            `📋 Ficha del pedido inyectada cliente=${id_cliente}: ${JSON.stringify(
              {
                nombre: fichaPedido.nombre,
                telefono: fichaPedido.telefono,
                ciudad: fichaPedido.ciudad,
                entrega: fichaPedido.entrega,
                direccion: fichaPedido.direccion,
                producto: fichaPedido.producto,
                cantidad: fichaPedido.cantidad,
                confirmo: fichaPedido.confirmo_pedido,
              },
            )}`,
          );
        }
      }
    } catch (e) {
      await log(`⚠️ Error armando la ficha del pedido: ${e.message}`);
      fichaPedido = null;
    }

    // c) cierre narrado sin tag en el turno anterior
    try {
      const ultimoIA = ultimosBot.find((m) =>
        /^IA_/i.test(String(m.responsable || '')),
      );
      const textoUltimo = String(ultimoIA?.texto_mensaje || '');
      if (
        ultimoIA &&
        !columna.es_dropi_principal &&
        esCierreNarrado(textoUltimo) &&
        !textoUltimo.startsWith(PREFIJO_PETICION_DATOS)
      ) {
        bloqueContexto +=
          `⚠️ CIERRE NO PROCESADO: en tu mensaje anterior diste el pedido por registrado/confirmado, pero el sistema NO lo procesó porque no traía el resumen completo con el tag ${accCierreVenta.trigger}. La venta NO está cerrada.\n` +
          `Ahora: si ya tienes todos los datos (revisa la ficha y la conversación), tu mensaje ES el resumen COMPLETO del pedido + ${accCierreVenta.trigger} en la última línea — sin volver a pedir nada que ya dio ni a pedir otra confirmación. Si de verdad falta un dato, pide SOLO ese. No vuelvas a agradecer la compra ni a decir "registrado" sin el tag, y no menciones ningún error.\n\n`;
        await log(
          `🩹 Cierre narrado sin tag en el turno anterior: nota de rescate inyectada cliente=${id_cliente}`,
        );
      }
    } catch (e) {
      await log(`⚠️ Error detectando cierre narrado previo: ${e.message}`);
    }
  }

  // ── 7. Construir input / enviar al thread ─────────────────
  let inputFinal = mensajeFinal;

  if (USAR_RESPONSES_API) {
    if (bloqueContexto.trim()) {
      /* El mensaje del cliente va MARCADO al final: pegado sin rótulo tras
         5-6 mil caracteres de contexto, un "Una" o un "1" se pierde y el
         modelo responde solo al contexto (mismo incidente cfg 366). */
      inputFinal =
        `🧾 Contexto adicional:\n\n${bloqueContexto.trim()}\n\n` +
        `💬 MENSAJE ACTUAL DEL CLIENTE (responde a ESTO):\n${mensajeFinal}`;
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
  let prefacioWizard = null;

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

    /* El source_id restaura el nivel 0 del resolver (el mapa
       anuncio→producto) en los turnos siguientes al click. Sin él, la
       reinyección resolvía SOLO por texto del headline, y un headline flojo
       ("SSD PORTATIL DE 8TB": una sola palabra útil) terminaba anclando otro
       producto — caso 403: cotizó la Máquina de Hielo SOKANY con la
       instrucción "usa SOLO estos precios". */
    let sourceIdAd = null;
    try {
      const [adRow] = await db.query(
        `SELECT source_id FROM cliente_productos_ad
          WHERE id_cliente = ? AND id_configuracion = ?
          ORDER BY id DESC LIMIT 1`,
        {
          replacements: [id_cliente, id_configuracion],
          type: db.QueryTypes.SELECT,
        },
      );
      sourceIdAd = adRow?.source_id || null;
    } catch (_) {}

    const bloqueProd = await buscarProductoPorReferral(
      id_configuracion,
      ultimoProductoAd,
      sourceIdAd,
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

  // ── 8.4 Wizard de producto (/productos2) ───────────────────
  // Si el producto del anuncio tiene wizard activo, su ficha (descripción IA,
  // bullets, FAQs, combos válidos y stock EN VIVO) reemplaza al bloque
  // genérico del referral. El modelo sigue siendo el de la columna
  // (kanban_columnas.modelo, se elige en la config del kanban). Gateado por el
  // wizard: las cuentas que no configuraron nada no cambian en nada.
  //
  // Acá solo se RESUELVE si hay ficha en juego; el bloque se arma después de
  // 8.5, porque su última línea depende de si el modelo verá catálogo o no.
  let wizardEnJuego = null;
  try {
    const {
      wizardDelClienteEnJuego,
    } = require('./producto_wizard_runtime.service');
    wizardEnJuego = await wizardDelClienteEnJuego(id_configuracion, id_cliente);
  } catch (eWiz) {
    await log(`⚠️ wizard motor: ${eWiz.message}`);
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
  } else if (columna.vector_store_id && wizardEnJuego) {
    // Fase 3 del wizard: con la ficha en juego el catálogo NO va por
    // file_search — sus fragmentos duplican lo que la ficha ya trae y quedan
    // pegados a la cadena de previous_response_id, re-cobrándose cada turno.
    // Los documentos (vector_store_docs_id) sí siguen: no tienen otra vía.
    await log(`🧩 Catálogo por file_search APAGADO: manda la ficha del wizard`);
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

  if (wizardEnJuego) {
    try {
      const {
        bloqueWizardParaMotor,
      } = require('./producto_wizard_runtime.service');
      // En Responses el bloque va al INICIO del prompt (prefacio): una regla
      // que debe cumplirse va arriba, no al final (caso 569: gpt-4o-mini
      // ignoraba lo enterrado). En Assistants (legacy) no se puede prefijar
      // el prompt del assistant, así que sigue por additional_instructions.
      // hayCatalogo: con inline la ficha remite al catálogo para otros
      // productos; sin catálogo (file_search apagado por la ficha) remite al
      // asesor.
      instruccionesProducto = bloqueWizardParaMotor(wizardEnJuego, {
        hayCatalogo: usarInline,
      });
      // Con un flujo de venta por pasos activo, la IA solo atiende el desvío:
      // responde la duda y retoma el embudo con la pregunta pendiente, tal
      // cual el negocio lo opera a mano. La pregunta va LITERAL.
      try {
        const {
          preguntaPendienteFlujo,
        } = require('./producto_wizard_runtime.service');
        const preguntaFlujo = await preguntaPendienteFlujo(
          id_configuracion,
          id_cliente,
        );
        if (preguntaFlujo) {
          instruccionesProducto +=
            `\n\n⚠️ FLUJO DE VENTA ACTIVO: este chat sigue un embudo por pasos que avanza SOLO con mensajes fijos del sistema. ` +
            `Tu ÚNICO trabajo en este turno es responder la duda puntual del cliente en 1-2 frases, sin re-presentar el producto. ` +
            `PROHIBIDO en este turno: pedir datos (nombre, teléfono, dirección), preguntar por envío o entrega, ofrecer promociones, ` +
            `intentar cerrar el pedido o hacer CUALQUIER otra pregunta propia. ` +
            `Tu mensaje debe terminar EXACTAMENTE con esta pregunta, escrita LITERAL y sin nada después:\n${preguntaFlujo}`;
          await log(`🪜 flujo: directiva de retome inyectada ("${preguntaFlujo.slice(0, 60)}")`);
        }
      } catch (eFlujo) {
        await log(`⚠️ flujo pregunta pendiente: ${eFlujo.message}`);
      }
      prefacioWizard = instruccionesProducto;
      await log(
        `🧩 wizard: ficha del producto ${wizardEnJuego.producto.id} inyectada (prefacio)`,
      );
    } catch (eWiz) {
      await log(`⚠️ wizard motor: ${eWiz.message}`);
    }
  }

  // ── 9. Ejecutar ───────────────────────────────────────────
  /* Candado por cliente: los huecos >8s que la ráfaga ya no agrupa corrían en
     paralelo, y las dos corridas leían el MISMO previous_response_id — la
     cadena se bifurcaba y el turno de la primera en guardar desaparecía de la
     memoria del bot para siempre (caso 569, Edgar, 2026-08-19: preguntó "¿qué
     producto necesitas?" 4 segundos después de presentar el shampoo; la rama
     del referral se perdió de la cadena). Se espera a que la corrida anterior
     del MISMO cliente guarde su response_id y se RELEE la cadena antes de
     llamar a OpenAI. Va después de la ráfaga a propósito —puesto antes
     bloquearía la agrupación— y cubre hasta después de guardarResponseId,
     porque soltar antes de guardar re-abre la ventana de la carrera.
     El try/finally abraza el try/catch que ya existía; la sangría interior se
     deja como estaba para que el diff sea legible. */
  const soltarTurnoCliente = await tomarTurnoCliente(id_cliente);
  let resultado;
  try {
  /* Releer la cadena: si otra corrida guardó mientras se esperaba el turno,
     acá se recoge. Si pasó de null a un id, el input ya se armó con la
     siembra del recap y va así: contexto repetido una vez sale más barato
     que perder la rama. */
  if (USAR_RESPONSES_API) {
    const cadenaFresca = await obtenerUltimoResponseId(id_cliente);
    if (cadenaFresca !== previous_response_id) {
      await log(
        `🔒 La cadena avanzó mientras se esperaba el turno: ` +
          `${previous_response_id || 'null'} → ${cadenaFresca || 'null'}`,
      );
      previous_response_id = cadenaFresca;
    }
  }

  try {
    if (USAR_RESPONSES_API) {
      await log(`🚨 entro sin polling NUEVO SISTEMA`);

      let instruccionesFinales = bloqueCatalogo
        ? `${assistantInfo.instructions}\n\n${bloqueCatalogo}`
        : assistantInfo.instructions;
      if (prefacioWizard) {
        instruccionesFinales = `${prefacioWizard}\n\n${instruccionesFinales}`;
      }

      resultado = await ejecutarConResponsesAPI({
        previous_response_id,
        instructions: instruccionesFinales,
        additional_instructions: prefacioWizard
          ? null
          : instruccionesProducto || null,
        input: inputFinal,
        model: assistantInfo.model,
        max_tokens: columna.max_tokens || 500,
        // El catálogo se apaga cuando va inline o cuando la ficha del wizard
        // está en juego (Fase 3); los documentos NO, porque no tienen otra
        // vía de llegar al modelo. Se gatea con prefacioWizard y no con
        // wizardEnJuego: si el armado de la ficha falló, el catálogo se queda.
        vector_store_id:
          usarInline || prefacioWizard ? null : columna.vector_store_id || null,
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
          vector_store_id:
            usarInline || prefacioWizard
              ? null
              : columna.vector_store_id || null,
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
  } finally {
    // Pase lo que pase (retorno temprano, throw del asistente), el turno se
    // suelta: si no, el próximo mensaje del cliente esperaría el tope de 90s.
    soltarTurnoCliente();
  }

  total_tokens += resultado.total_tokens;
  if (resultado.usage) analyticsIA = resultado.usage;
  const respuestaCruda = resultado.respuesta;
  // `let`: el paso 10 puede completarla con la ficha del pedido o inferirle el
  // tag de cierre (ver 9.9).
  let respuestaRaw = sanitizarRespuestaAgente(respuestaCruda);

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

      /* Se pide que coincidan las palabras que DISTINGUEN el nombre, no una
         suelta: "profesional" o "facial" aparecen en medio catálogo y
         mandarían a la columna equivocada a quien pregunta por un
         tratamiento. La regla (palabras vacías, match por palabra entera,
         el más específico gana) vive en utils/productoNombrado.js, compartida
         con el adjunto de fotos del paso 12. */
      const nombrado = productoNombrado(mensaje, productos);

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

  /* ── 9.85 Guardia del paso de oficina (switch retiro en agencia) ──
     Si el pedido es con retiro, no hay oficina elegida ni lista ofrecida, y
     el modelo pide nombre/teléfono (el guion base le gana a los prompts), su
     respuesta se REEMPLAZA en código: pregunta de ciudad, o la lista real de
     oficinas del directorio. Determinístico, nunca revienta el turno. */
  try {
    const {
      guardiaOficinaRetiro,
    } = require('./kanban_retiro_agencia.service');
    const guardia = await guardiaOficinaRetiro({
      respuesta: respuestaRaw,
      ficha: fichaPedido,
      id_configuracion,
      id_cliente,
      mensajeCliente: mensaje,
    });
    if (guardia) {
      respuestaRaw = guardia.texto;
      await log(`🏦 Guardia de oficina de retiro: ${guardia.motivo} (respuesta reemplazada)`);
    }
  } catch (eGuard) {
    await log(`⚠️ Guardia de oficina falló (se sigue igual): ${eGuard.message}`);
  }

  /* ── 9.9 Cierre narrado sin tag: inferirlo ──
     El modelo escribe el resumen completo y "¡Gracias por tu compra!" pero se
     come el tag (caso 302, Josué, 2026-08-19: tres cierres seguidos sin
     `[generar_guia]:true`; el chat nunca se movió y al cliente le llegó el
     "resumen final" cuatro veces). Para el cliente ESO es un cierre; para el
     sistema no era nada. Si la respuesta trae un resumen reconocible (3+
     rótulos, con Producto) y una frase de cierre, y NINGÚN tag de esta
     columna, se le agrega el tag de cierre y sigue por el paso 10 como
     cualquier cierre: el validador decide si los datos alcanzan, y si no, se
     le piden al cliente SOLO los que falten. Sin resumen no se infiere nada
     (ahí va la nota de rescate del 6.8 en el turno siguiente). */
  let cierreInferido = false;
  // No en la columna principal de Dropi: ahí "gracias por tu compra" es la
  // confirmación de una orden que ya existe, no un cierre nuevo.
  if (accCierreVenta && !columna.es_dropi_principal) {
    const trajoAlgunTag = getAcciones('cambiar_estado')
      .map((ac) => parseConfig(ac).trigger)
      .filter(Boolean)
      .some((t) => respuestaRaw.toLowerCase().includes(String(t).toLowerCase()));
    if (
      !trajoAlgunTag &&
      esCierreNarrado(respuestaRaw) &&
      pareceResumenDePedido(respuestaRaw)
    ) {
      respuestaRaw = `${respuestaRaw.trimEnd()}\n${accCierreVenta.trigger}`;
      cierreInferido = true;
      await log(
        `🧷 Cierre narrado SIN tag: resumen + frase de cierre sin ${accCierreVenta.trigger}. Se infiere el tag y sigue por el validador.`,
      );
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
        /* Completar con la ficha ANTES de validar: si el modelo omitió la
           línea Nombre/Ciudad o la escribió a medias ("Nombre: Josué") y el
           cliente SÍ lo dijo, se completa acá. Así el cierre pasa con los
           datos reales y la petición del paso 12 queda solo para lo que de
           verdad no está en la conversación (caso 360, Delfin: la petición le
           pedía "Nombre completo" a quien ya lo había escrito dos veces). Lo
           que se completa sale también en el mensaje al cliente, que ve el
           resumen entero. */
        if (fichaPedido) {
          const comp = completarResumenConFicha(respuestaRaw, fichaPedido);
          if (comp.completados.length) {
            respuestaRaw = comp.texto;
            await log(
              `📋 Resumen de cierre completado con la ficha: ${comp.completados.join(', ')}`,
            );
          }
        }
        /* Red de seguridad del retiro en agencia (switch retiro_agencia):
           la línea 🏡 de un cierre con agencia se valida contra el
           directorio real y se corrige en código — el modelo a veces
           confirma la oficina bien en la conversación y la pierde al armar
           el resumen. Lo corregido llega igual al cliente, a la columna y
           al auto-orden. Nunca bloquea el cierre. */
        try {
          const {
            corregirDireccionRetiro,
          } = require('./kanban_retiro_agencia.service');
          const corr = await corregirDireccionRetiro(
            respuestaRaw,
            id_configuracion,
            id_cliente,
          );
          if (corr) {
            respuestaRaw = corr.texto;
            await log(`📍 Dirección de retiro corregida: ${corr.motivo}`);
          }
        } catch (eDir) {
          await log(
            `⚠️ Validación de dirección de retiro falló (se sigue igual): ${eDir.message}`,
          );
        }
        const motivo = motivoCierreInvalido(respuestaRaw, fichaPedido);
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
          /* Rótulos SIN emoji en el regex y anclados a inicio de línea (hasta
             6 caracteres de adorno: emoji, asteriscos, guión). El "🧑?" viejo
             hacía el emoji OBLIGATORIO —sin flag `u`, el `?` aplica solo a la
             segunda mitad del surrogate pair— y un resumen "🧑 *Nombre:*" no
             extraía nada: el auto-orden se quedaba sin datos y todo caía al
             extractor IA. Los valores se limpian de asteriscos/guiones bajos
             de negrita, igual que hace camposFaltantesCierre. */
          const g = (re) =>
            respuestaRaw
              .match(re)?.[1]
              ?.replace(/[*_]/g, '')
              .trim() || '';
          const datosBot = {
            nombre: g(/(?:^|\n)[^\n]{0,6}?Nombre(?:\s+completo)?\s*:\s*(.+)/i),
            telefono: g(/(?:^|\n)[^\n]{0,6}?Tel[eé]fono\s*:\s*(.+)/i) || telefono,
            // Acepta el término regional según el país (provincia EC/PA,
            // departamento CO/PE/GT, estado MX, región CL).
            provincia: g(
              /(?:^|\n)[^\n]{0,6}?(?:Provincia|Departamento|Depto\.?|Estado|Regi[oó]n)\s*:\s*(.+)/i,
            ),
            ciudad: g(/(?:^|\n)[^\n]{0,6}?Ciudad\s*:\s*(.+)/i),
            direccion: g(/(?:^|\n)[^\n]{0,6}?Direcci[oó]n[^:\n]{0,25}:\s*(.+)/i),
            producto: g(/(?:^|\n)[^\n]{0,6}?Producto\s*:\s*(.+)/i),
            // "Total:" con \b para que un "Subtotal:" no cuente como total.
            precio: g(/(?:^|\n)[^\n]{0,6}?(?:Precio\s+total|\bTotal)\s*:\s*(.+)/i),
            cantidad: g(/(?:^|\n)[^\n]{0,6}?Cantidad\s*:\s*(.+)/i) || '',
            // Modalidad de envío (opcional): "domicilio" o "agencia
            // servientrega". Si el bot la incluye, el auto-orden fuerza
            // Servientrega cuando es agencia.
            modalidad_envio:
              g(/(?:^|\n)[^\n]{0,6}?Env[ií]o\s*:\s*(.+)/i) ||
              g(/(?:^|\n)[^\n]{0,6}?Modalidad\s*:\s*(.+)/i) ||
              // Una línea "Agencia de retiro: X" implica retiro en agencia
              // aunque el resumen no traiga línea "Envío:" (formato cfg 666).
              (g(/(?:^|\n)[^\n]{0,6}?Agencia[^:\n]*:\s*(.+)/i)
                ? 'agencia servientrega'
                : ''),
            // Variedad elegida en productos variables (talla/color). Sin esto
            // el auto-orden no sabe qué variante subir y Dropi rechaza la
            // orden. Se aceptan varios rótulos porque el prompt de cada
            // cliente los escribe distinto.
            variedad:
              g(/(?:^|\n)[^\n]{0,6}?Variedad\s*:\s*(.+)/i) ||
              g(/(?:^|\n)[^\n]{0,6}?Variante\s*:\s*(.+)/i) ||
              g(/(?:^|\n)[^\n]{0,6}?Color\s*:\s*(.+)/i) ||
              g(/(?:^|\n)[^\n]{0,6}?Talla\s*:\s*(.+)/i) ||
              '',
          };

          /* Renglones cuando el resumen trae varias líneas "📦 Producto:"
             (pedido de más de un producto). Con una sola línea, `productos`
             no se agrega y el auto-orden corre el flujo de siempre. */
          const productosResumen = parsearProductosResumen(respuestaRaw);
          if (productosResumen.length) datosBot.productos = productosResumen;

          // Datos que el cliente pudo corregir (para el flujo de actualizar).
          const cambios = {
            nombre: g(/(?:^|\n)[^\n]{0,6}?Nombre(?:\s+completo)?\s*:\s*(.+)/i),
            telefono: g(/(?:^|\n)[^\n]{0,6}?Tel[eé]fono\s*:\s*(.+)/i),
            ciudad: g(/(?:^|\n)[^\n]{0,6}?Ciudad\s*:\s*(.+)/i),
            direccion: g(/(?:^|\n)[^\n]{0,6}?Direcci[oó]n[^:\n]{0,25}:\s*(.+)/i),
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
     que sí progresa nunca escala.

     El límite era 10 y quedaba justo: una venta COD completa sin ningún tag
     intermedio ya consume ~9 respuestas (presentación, variedad, upsell,
     nombre, teléfono, ciudad, tipo de entrega, agencia, cierre), así que una
     sola pregunta extra del cliente escalaba a asesor ventas que iban bien
     (caso 569 del 2026-08-18: escaló en plena elección de agencia). Con 15
     sigue cortando los chats infinitos —que es su trabajo— sin comerse el
     margen normal de una venta con dudas. */
  const LIMITE_TURNOS_SIN_AVANCE = 15;

  const triggersColumna = acciones
    .map((ac) => parseConfig(ac).trigger)
    .filter(Boolean);

  /* Un cierre BLOQUEADO no es avance: el tag está en respuestaRaw (por eso el
     some() lo encontraba) pero la columna NO se movió y al cliente le llegó la
     petición de datos. Contarlo reseteaba turnos_sin_avance en cada vuelta del
     loop y la red del asesor nunca saltaba, justo en el único escenario donde
     más falta hace (caso 495, Iván: 4 cierres bloqueados seguidos con el
     contador siempre en cero). */
  const avanzo =
    (!cierreBloqueado &&
      triggersColumna.some((t) =>
        respuestaRaw.toLowerCase().includes(String(t).toLowerCase()),
      )) ||
    escribioBloqueCita;

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

      /* Mismo matcher que el enrutado (utils/productoNombrado.js). La copia
         vieja —"dos palabras del nombre de más de 3 letras", sin palabras
         vacías— le adjuntaba la foto del "Kit COMPLETO 800 vinchas PARA Auto"
         cada vez que el bot decía "tu nombre COMPLETO… PARA completar el
         pedido" (405, Celia y 4 clientes más, 2026-08-20): al pedir la
         dirección llegaba la foto de otro producto y el negocio la borraba a
         mano. */
      const mencionado = productoNombrado(respuestaRaw, conImagen);

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
    /* Se pide SOLO lo que de verdad falta o vino de relleno. Pedir los
       cuatro grupos cuando el cliente ya dio tres suena a bot perdido y
       repregunta datos ya dados — la misma enfermedad que se curó en
       contextoColumna. El análisis campo por campo es EL MISMO del candado
       del paso 10 (camposFaltantesCierre): un solo criterio, o el candado
       bloquearía por una cosa y esta petición pediría otra. */
    const faltan = camposFaltantesCierre(respuestaRaw, fichaPedido);

    /* Tope de reintentos: si ya hay DOS peticiones en los últimos mensajes,
       este es el TERCER cierre bloqueado seguido — el modelo no está logrando
       armar el resumen ni con la nota de rescate del 6.7. Repetir la misma
       línea otra vez es enseñarle al cliente un robot roto (caso 495, Iván:
       4 idénticas y se fue). Se escala a asesor, igual que cuando una cita
       falla: que lo cierre una persona. */
    let escaladoAsesor = false;
    if (peticionesCierrePrevias >= 2) {
      try {
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
          soloTexto =
            '¡Gracias por tu paciencia! 🙏 Un asesor va a revisar tu pedido y te confirma enseguida.';
          escaladoAsesor = true;
          await log(
            `🚨 Tercer cierre bloqueado consecutivo (faltaba: ${
              faltan.map((f) => f.replace(/^- /, '')).join(' | ') || '?'
            }): cliente ${id_cliente} movido a "asesor" en vez de repetir la petición`,
          );
        } else {
          await log(
            `⚠️ Tercer cierre bloqueado consecutivo y la config ${id_configuracion} no tiene columna "asesor": se repite la petición`,
          );
        }
      } catch (e) {
        await log(`⚠️ Error escalando cierre bloqueado a asesor: ${e.message}`);
      }
    }

    if (!escaladoAsesor) {
      soloTexto =
        faltan.length === 1
          ? `${PREFIJO_PETICION_DATOS} este dato 😊:\n${faltan[0]}`
          : `${PREFIJO_PETICION_DATOS} estos datos 😊:\n` +
            (faltan.length
              ? faltan.join('\n')
              : '- Nombre completo\n- Teléfono\n- Ciudad y provincia\n' +
                '- Dirección exacta (dos calles y una referencia), o la ' +
                'agencia Servientrega si prefieres retirarlo');
    }
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
  let resumenRepetido = false;
  if (cerroLaVenta && !reclamarResumenCierre(claveResumen)) {
    resumenRepetido = true;
    if (soloTexto) {
      await log(
        `🔁 Resumen de cierre repetido para cliente=${id_cliente}: no se envía ` +
          `(ya salió uno hace menos de 5 min; el cliente escribió en ráfaga)`,
      );
      soloTexto = '';
    }
  }

  /* Opción del embudo: cerrar SIN mandarle el resumen técnico al cliente —
     solo el mensaje de venta realizada (abajo). El cambio de columna y el
     auto-orden Dropi NO se afectan: corrieron en el paso 10 sobre
     respuestaRaw, mucho antes de este envío. */
  let finFlujo = null;
  if (cerroLaVenta && wizardEnJuego) {
    try {
      const {
        mensajeVentaRealizada,
      } = require('./producto_wizard_runtime.service');
      finFlujo = mensajeVentaRealizada(wizardEnJuego.wizard);
    } catch (eFin) {
      await log(`⚠️ venta realizada: ${eFin.message}`);
    }
    if (finFlujo?.ocultar_resumen && soloTexto) {
      await log(
        `🙈 flujo: resumen de cierre NO enviado al cliente (opción del embudo); ` +
          `la columna y el auto-orden ya se procesaron con él`,
      );
      soloTexto = '';
    }
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
        analytics: analyticsIA,
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
        analytics: analyticsIA,
      });
    }
  }

  /* Mensaje de VENTA REALIZADA del embudo (el "Flujo 7" del wizard): si esta
     respuesta cerró la venta y el producto en juego lo tiene configurado,
     sale DESPUÉS del resumen — copy fijo + imagen, 0 tokens. En ráfaga
     (resumen repetido) tampoco se repite este mensaje. */
  if (cerroLaVenta && !resumenRepetido && finFlujo) {
    try {
      for (const url of (finFlujo.media || []).slice(0, 4)) {
        const tipoM = /\.(mp4|mov|3gp)(\?|$)/i.test(url) ? 'video' : 'image';
        await canal
          .enviarMedia({ tipo: tipoM, url, responsable: 'IA_flujo_venta' })
          .catch(async (e) =>
            log(`⚠️ venta realizada: falló ${tipoM} ${url}: ${e.message}`),
          );
      }
      // El copy después de la media, misma razón que el paquete inicial.
      if ((finFlujo.media || []).length && finFlujo.copy) {
        await new Promise((r) => setTimeout(r, 2000));
      }
      if (finFlujo.copy) {
        await canal.enviarTexto({
          texto: finFlujo.copy,
          responsable: 'IA_flujo_venta',
          total_tokens: 0,
        });
      }
      await log(
        `🏁 flujo: mensaje de VENTA REALIZADA enviado (${(finFlujo.media || []).length} media)`,
      );
    } catch (eFin) {
      await log(`⚠️ venta realizada: ${eFin.message}`);
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

  // gpt-5* son modelos de razonamiento: los tokens de razonamiento descuentan
  // de max_output_tokens, así que con el tope de 500 de una columna normal la
  // respuesta puede volver VACÍA (status "incomplete"). Se razona poco
  // (effort low), se sube el piso del tope y, si aun así vuelve vacío, se
  // reintenta UNA vez con más tope y razonamiento mínimo. No aplica
  // temperature (gpt-5 no la acepta) — acá nunca se mandó, así que no cambia.
  const esGpt5 = /^gpt-5/i.test(body.model);
  if (esGpt5) {
    body.reasoning = { effort: 'low' };
    body.max_output_tokens = Math.max(Number(body.max_output_tokens) || 0, 2000);
  }

  let res = await axios.post('https://api.openai.com/v1/responses', body, {
    headers,
    timeout: 60000,
  });

  const leerTexto = (data) => {
    const items = data?.output || [];
    const msg = items.find((item) => item.type === 'message');
    const c = msg?.content?.find((x) => x.type === 'output_text');
    return { rawText: c?.text || '', annotations: c?.annotations || [] };
  };

  let { rawText, annotations } = leerTexto(res.data);

  if (esGpt5 && !rawText.trim() && res.data?.status === 'incomplete') {
    const reintento = {
      ...body,
      reasoning: { effort: 'minimal' },
      max_output_tokens: Math.min(body.max_output_tokens * 2, 8000),
    };
    res = await axios.post('https://api.openai.com/v1/responses', reintento, {
      headers,
      timeout: 60000,
    });
    ({ rawText, annotations } = leerTexto(res.data));
  }

  const response_id = res.data.id;
  const total_tokens = res.data.usage?.total_tokens || 0;
  // Desglose para el panel de consumo: con el modelo y los tokens de entrada
  // (cacheados aparte) y salida se calcula el costo exacto de la respuesta.
  const u = res.data.usage || {};
  const usage = {
    modelo: body.model,
    input: Number(u.input_tokens) || 0,
    cached: Number(u.input_tokens_details?.cached_tokens) || 0,
    output: Number(u.output_tokens) || 0,
    reasoning: Number(u.output_tokens_details?.reasoning_tokens) || 0,
  };

  const respuesta = limpiarCitasResponsesAPI(rawText, annotations);

  return { respuesta, response_id, total_tokens, usage };
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
 * Además se geocodifica en reversa (utils/geoUbicacion): con la dirección,
 * ciudad y provincia resueltas, el bot puede escribirlas en el resumen de
 * cierre — que es de donde salen el auto-orden de Dropi y el auto-llenado del
 * panel de pedido. Antes el cliente mandaba su ubicación y el bot igual tenía
 * que pedirle ciudad y dirección "en palabras", porque no sabía leerla.
 *
 * Devuelve `null` si el texto no es una ubicación, para que el mensaje siga su
 * camino sin tocarse. Si el geocoder no responde, cae al texto de siempre
 * (coordenadas + mapa) y el bot pide los datos como antes.
 */
async function textoDeUbicacion(texto) {
  const coords = parseUbicacionJson(texto);
  if (!coords) return null;

  const { lat, lng } = coords;
  const mapa = `https://www.google.com/maps?q=${lat},${lng}`;
  const geo = await reverseGeocode(lat, lng);

  if (!geo) {
    return (
      `[El cliente compartió su ubicación por WhatsApp]\n` +
      `Coordenadas: ${lat}, ${lng}\n` +
      `Mapa: ${mapa}\n` +
      `Ya tienes su ubicación: NO se la vuelvas a pedir ni le pidas la ` +
      `dirección "en palabras". Si necesitas el nombre del sector o una ` +
      `referencia para llegar, pídele eso puntual. Cuando tengas que dejar la ` +
      `ubicación registrada en una ficha, escribe el enlace del mapa tal cual.`
    );
  }

  return (
    `[El cliente compartió su ubicación por WhatsApp]\n` +
    `Coordenadas: ${lat}, ${lng}\n` +
    `Mapa: ${mapa}\n` +
    `Según el mapa, la ubicación corresponde a:\n` +
    `- Dirección: ${geo.direccion || '(sin calle identificable en el mapa)'}\n` +
    `- Ciudad: ${geo.ciudad || '(no identificada)'}\n` +
    `- Provincia: ${geo.provincia || '(no identificada)'}\n` +
    `Ya tienes su ubicación: NO se la vuelvas a pedir ni le pidas la ` +
    `dirección "en palabras", y NO le vuelvas a preguntar la ciudad ni la ` +
    `provincia si aquí aparecen. Si estás cerrando un pedido con entrega, usa ` +
    `esta ciudad, provincia y dirección tal cual en el resumen de cierre, y ` +
    `pídele al cliente solo una referencia puntual para llegar (color de la ` +
    `casa, negocio cercano) para completar la dirección. Cuando tengas que ` +
    `dejar la ubicación registrada en una ficha, escribe el enlace del mapa ` +
    `tal cual.`
  );
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
   producto" ahí sería absurdo — sí sabe de qué venían hablando.

   ⚠️ Extended_Pictographic y NO \p{Emoji}: en Unicode los dígitos 0-9, "#" y
   "*" tienen la propiedad Emoji (son la base de los keycaps 1️⃣), así que con
   \p{Emoji} un cliente que respondía "1" a "¿cuántas unidades?" quedaba
   clasificado como reacción y su mensaje se reemplazaba por "[el cliente no
   escribió nada más]" — el bot re-preguntaba la cantidad en bucle hasta
   perder la venta (cfg 366, Carlos, 2026-08-26: cuatro "1" ignorados). */
const soloEmojis = (s) =>
  s.length <= 8 &&
  /^[\p{Extended_Pictographic}️‍\u{1F3FB}-\u{1F3FF}\s]+$/u.test(s) &&
  /\p{Extended_Pictographic}/u.test(s);

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

/* El remarketing se genera con un mensaje-trigger interno ("[ACCIÓN INTERNA:
   GENERAR_REMARKETING] … Devuelve ÚNICAMENTE el mensaje…") y el modelo a
   veces le responde AL SISTEMA antes de escribir el mensaje: al cliente de la
   569 (2026-08-19) le llegó "¡Entendido! 😊 Aquí tienes el mensaje de
   remarketing:" seguido del mensaje real. Esto corta ese acuse y cualquier
   línea con jerga interna, en el único formato que puede viajar al cliente.

   Fail-safe: si después de limpiar no queda nada usable, se devuelve el
   original — un preámbulo feo es mejor que un mensaje vacío que tumba el
   envío y dispara el fallback. */
function limpiarMetaRemarketing(texto) {
  const original = String(texto || '').trim();
  let t = original;

  // 1) Preámbulo que anuncia el mensaje y termina en dos puntos:
  //    "¡Entendido! 😊 Aquí tienes el mensaje de remarketing:" / "Te comparto
  //    el mensaje de reenganche:".
  t = t.replace(
    /^[^\n]{0,140}?(?:mensaje\s+de\s+(?:remarketing|reenganche|reactivaci[oó]n|seguimiento)|aqu[ií]\s+(?:tienes|est[aá])\s+(?:el|tu)\s+mensaje|te\s+comparto\s+el\s+mensaje)[^\n]{0,80}?:\s*/i,
    '',
  );

  // 2) Primera línea que es SOLO un acuse al sistema ("¡Entendido!", "Claro").
  //    Exige el salto de línea: un mensaje legítimo que ARRANCA con
  //    "¡Perfecto! Tu descuento…" en la misma línea no se toca.
  t = t.replace(
    /^[¡!]?\s*(?:entendido|claro(?:\s+que\s+s[ií])?|listo|perfecto|de\s+acuerdo|ok)\s*[.!,…]*\s*[😊🙂👍]?\s*\n+/i,
    '',
  );

  // 3) Jerga interna que jamás puede llegarle a un cliente.
  t = t
    .split('\n')
    .filter(
      (l) => !/remarketing|reenganche|GENERAR_REMARKETING|ACCI[ÓO]N\s+INTERNA/i.test(l),
    )
    .join('\n')
    .trim();

  return t.length >= 5 ? t : original;
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
    /* Bot apagado desde Asistentes: no se CREA el remarketing. El cron ya no
       enviaba con el bot apagado, pero los pendientes se seguían creando y el
       cliente los veía como "programados" en el chat — automatización a
       medias. Apagado = todo en manual, y esto corta a TODOS los que agendan
       (webhook WA, notifier Dropi/Aliclik, Shopify, gateway, citas). */
    if (await botApagadoExplicito(id_configuracion)) {
      await log(
        `🔌 SKIP programarRemarketing — bot apagado en Asistentes (cfg=${id_configuracion})`,
      );
      return;
    }

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
  // Lo usa simular_conversacion.js para armar el catálogo inline EXACTAMENTE
  // como producción: si el puente cambia acá, la simulación cambia sola.
  PUENTE_INLINE,
  // Exportados para reutilizar la generación IA desde el remarketing de IG
  // (no cambian el comportamiento de WhatsApp; son helpers puros de OpenAI).
  ejecutarAsistente,
  ejecutarConResponsesAPI,
  // Lo usa el cron de remarketing: los mensajes que redacta con el asistente de
  // una columna pueden traer tags de acción, y ahí nadie los interpretaba ni los
  // limpiaba (ver cron/remarketing.js → generarMensajeRemarketingIA).
  limpiarTagsAcciones,
  // Corta el acuse al sistema ("Aquí tienes el mensaje de remarketing:") que
  // el modelo antepone a veces al mensaje generado. La usan los tres canales
  // de remarketing (WA/IG/MS).
  limpiarMetaRemarketing,
  // La usa el cron de remarketing cuando el cliente no tiene cadena de
  // Responses (nunca corrió la IA con él): sin recap, el modelo generaba el
  // recordatorio a ciegas y ofrecía OTRO producto del catálogo (cfg 610:
  // entró por cuchillos y el remarketing le habló del cinturón menstrual).
  construirRecapConversacion,
  // Expuesta para poder verificar el agendamiento sin levantar toda la
  // conversación: es el camino donde una falla no se ve (la tarjeta se mueve
  // igual aunque la cita no se cree).
  procesarAgendarCita,
  // Expuestas para la batería de regresión: que un cierre con placeholders o
  // incompleto no cuente como venta es una garantía que no puede perderse en
  // silencio.
  motivoCierreInvalido,
  camposFaltantesCierre,
  // Expuesta para la batería: el parseo del resumen multi-producto decide si
  // el auto-orden sube 1 o N renglones, y un cambio silencioso ahí rompe
  // pedidos reales.
  parsearProductosResumen,
  // Expuesta para la batería: la traducción de la ubicación de WhatsApp es lo
  // que le da al bot la ciudad/provincia/dirección del resumen de cierre; si
  // se rompe, el síntoma es un bot que vuelve a pedir la dirección "en
  // palabras" a quien acaba de mandarla.
  textoDeUbicacion,
};
