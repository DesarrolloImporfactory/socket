/**
 * Simula una conversación completa contra los prompts y modelos REALES de una
 * cuenta (Responses API, igual que producción), sin mandar un solo mensaje de
 * WhatsApp.
 *
 * Reproduce el camino de producción: inyecta el mismo contexto que arma
 * kanban_ia.service (sedes, agenda, precios, fichas, planes de sesiones), corre
 * el prompt de la columna donde está el contacto con su catálogo (inline o
 * file_search, la misma decisión que el runtime), aplica los tags para
 * moverlo de columna, limpia las coletillas de relleno y trocea el texto igual
 * que el envío real. La cadena es del cliente, no de la columna: al cambiar de
 * etapa cambian las instrucciones pero la conversación sigue.
 *
 * Existe para no tener que desplegar y probar con clientes de verdad.
 *
 * Uso:
 *   node scripts/simular_conversacion.js <id_configuracion> <id_cliente> "msg1" "msg2" ...
 *   node scripts/simular_conversacion.js 818 566217 --guion=laser
 */

require('dotenv').config();
const { db } = require('../src/database/config');
/* La MISMA función que usa producción para hablar con OpenAI (Responses API,
   piso de tokens para gpt-5, tope de fragmentos de file_search, reintento si
   vuelve vacío). Antes el simulador corría los assistants de las columnas por
   la API de Assistants, pero esos assistants murieron (404) con la migración
   a Responses del 2026-08-26: el prompt ahora vive en la BD
   (kanban_columnas.instrucciones) y acá se lee de ahí, igual que kanban_ia. */
const {
  ejecutarConResponsesAPI,
  PUENTE_INLINE,
} = require('../src/services/kanban_ia.service');
const { catalogoInlineActivo } = require('../src/utils/openia/fileSearch');
const { construirContextoColumna } = require('../src/utils/contextoColumna');
const { limpiarColetillas } = require('../src/utils/limpiarColetillas');
const { humanizarFechas } = require('../src/utils/humanizarFechas');
const { limpiarMarkdown } = require('../src/utils/formatoWhatsapp');
const {
  dividirRespuestaIA,
} = require('../src/utils/openia/dividirRespuestaIA');

/* Base histórica. La lista real se completa en main() con los triggers de las
   acciones de la cuenta: cada tablero tiene los suyos y un tag que no esté acá
   no se limpia, así que se le vería al cliente en el texto. */
const TAGS = [
  '[califica]:true',
  '[fuera_zona]:true',
  '[venta_producto]:true',
  '[cita_confirmada]:true',
  '[en_tratamiento]:true',
  '[plan_terminado]:true',
  '[no_asistio]:true',
  '[perdido]:true',
  '[asesor]:true',
  '[urgencia]:true',
];

const GUIONES = {
  /* ── Dropshipping ──────────────────────────────────────────────────
     El contexto que se inyecta (precios, fichas, media) lo comparten TODOS los
     tableros, no solo los de servicios. Un cambio pensado para estética ya
     rompió una vez los combos de dropshipping —el bloque decía "no cotices
     paquetes" y los bots pasaron a vender unidades sueltas—, así que estos dos
     guiones existen para correrlos ANTES de subir cualquier cambio a
     contextoColumna o al pipeline de respuesta. */
  dropi_combo: [
    // Nombra el producto con el nombre del CATÁLOGO: la regla vigente del
    // prompt deriva al asesor cuando el nombre no coincide ("la rodillera" a
    // secas se iba a asesor). Con el nombre bueno el guion llega a los
    // combos, que es lo que se quiere verificar.
    'hola, cuanto cuestan las rodilleras para bebe?',
    'y si llevo 2?',
    'dale, quiero 2',
  ],
  dropi_pedido: [
    'quiero comprar uno',
    'Juan Perez, 0987654321, Av. Amazonas y Colon, Quito, Pichincha',
  ],

  // ── Servicios (inmobiliaria) ────────────────────────────────────
  // La 818 dejó de ser estética: su tablero capta propietarios y agenda
  // visitas a inmuebles. Este guion arranca en por_agendar (--desde).
  visita: [
    'hola, me interesa el departamento, quisiera ir a verlo',
    'puede ser manana?',
    'a las 10 esta bien',
  ],

  // ── Servicios (estética / clínica) ──────────────────────────────
  laser: [
    'Hola, quiero informacion sobre la depilacion laser',
    'si quiero',
    'manana',
    'a las 10 esta bien',
  ],
  producto: [
    'hola, quiero comprar la maquina recortadora de cabello profesional',
    'que trae? tiene garantia?',
    'dale, la quiero',
    'yo me acerco a retirarla',
  ],
  fuera: [
    'Hola, quiero informacion de la depilacion laser',
    'escribo desde Cuenca',
    'nada mas gracias',
  ],
  // Post-cita: el cron pregunta cómo le fue y ella responde.
  asistio_bien: [
    'me fue increible, quede feliz con el resultado',
    'si, quiero seguir con el tratamiento completo',
  ],
  asistio_mal: [
    'la verdad no pude ir, se me complico el dia',
  ],
  tratamiento: [
    'hola, quiero agendar mi siguiente sesion de depilacion laser',
    'el lunes a las 11 porfa',
  ],
  no_asistio: [
    'perdon, se me paso la cita de ayer',
    'si, quiero reagendar',
  ],
  reprogramar: [
    'necesito cambiar mi cita para otro dia',
    'el martes en la tarde',
  ],
  inexistente: [
    'hacen botox? cuanto cuesta',
  ],
};

const [, , argConfig, argCliente, ...resto] = process.argv;
const ID_CONFIG = Number(argConfig);
const ID_CLIENTE = Number(argCliente);

const guion = resto.find((a) => a.startsWith('--guion='));
const MENSAJES = guion
  ? GUIONES[guion.split('=')[1]] || []
  : resto.filter((a) => !a.startsWith('--'));

if (!ID_CONFIG || !ID_CLIENTE || !MENSAJES.length) {
  console.error(
    'Uso: node scripts/simular_conversacion.js <id_configuracion> <id_cliente> "mensaje" ...\n' +
      `Guiones listos: ${Object.keys(GUIONES).join(', ')}`,
  );
  process.exit(1);
}

let API_KEY;

/* Un turno contra la Responses API con la MISMA decisión de catálogo que
   producción: inline dentro de las instrucciones si está habilitado y cabe
   (y entonces el vector store del catálogo va en null), file_search si no.
   Los documentos del cliente siempre viajan. Devuelve el texto y el id de la
   respuesta para encadenar el turno siguiente. */
async function correr(col, input, previous_response_id) {
  const usarInline =
    !!(col.catalogo_inline || '').trim() &&
    catalogoInlineActivo(ID_CONFIG, Number(col.catalogo_inline_tokens || 0));

  const instructions = usarInline
    ? `${col.instrucciones}\n\n${PUENTE_INLINE}\n\n${col.catalogo_inline.trim()}`
    : col.instrucciones;

  const r = await ejecutarConResponsesAPI({
    previous_response_id,
    instructions,
    additional_instructions: null,
    input,
    model: col.modelo,
    max_tokens: col.max_tokens || 700,
    vector_store_id: usarInline ? null : col.vector_store_id || null,
    vector_store_docs_id: col.vector_store_docs_id || null,
    api_key_openai: API_KEY,
    id_configuracion: ID_CONFIG,
  });

  return {
    texto: r.respuesta || '(sin respuesta)',
    response_id: r.response_id,
    catalogo: usarInline ? 'inline' : col.vector_store_id ? 'file_search' : 'sin catálogo',
  };
}

async function main() {
  const [cfg] = await db.query(
    `SELECT api_key_openai FROM configuraciones WHERE id = ? LIMIT 1`,
    { replacements: [ID_CONFIG], type: db.QueryTypes.SELECT },
  );
  if (!cfg?.api_key_openai)
    throw new Error(`La configuración ${ID_CONFIG} no tiene api_key_openai`);

  API_KEY = cfg.api_key_openai;

  const columnas = await db.query(
    `SELECT id, estado_db, nombre, max_tokens, modelo, instrucciones,
            vector_store_id, vector_store_docs_id,
            catalogo_inline, catalogo_inline_tokens
       FROM kanban_columnas
      WHERE id_configuracion = ? AND activo = 1 AND activa_ia = 1`,
    { replacements: [ID_CONFIG], type: db.QueryTypes.SELECT },
  );

  const porEstado = new Map(columnas.map((c) => [c.estado_db, c]));

  // Acciones de cada columna: definen el contexto que se inyecta y a dónde
  // mueve cada tag.
  for (const col of columnas) {
    col.acciones = await db.query(
      `SELECT tipo_accion, config FROM kanban_acciones
        WHERE id_kanban_columna = ? AND activo = 1`,
      { replacements: [col.id], type: db.QueryTypes.SELECT },
    );
  }

  /* Los tags que de verdad usa este tablero, sacados de las acciones. */
  const tagsCuenta = new Set(TAGS);
  for (const col of columnas) {
    for (const ac of col.acciones) {
      const c = typeof ac.config === 'string' ? JSON.parse(ac.config || '{}') : ac.config || {};
      if (c.trigger) tagsCuenta.add(c.trigger);
    }
  }
  const TAGS_CUENTA = [...tagsCuenta];

  const [contacto] = await db.query(
    `SELECT estado_contacto FROM clientes_chat_center WHERE id = ? LIMIT 1`,
    { replacements: [ID_CLIENTE], type: db.QueryTypes.SELECT },
  );

  const desde = resto.find((a) => a.startsWith('--desde='));
  // Permite probar una columna sin tener que mover el contacto a mano.
  let estado = desde ? desde.split('=')[1] : contacto?.estado_contacto || 'contacto_inicial';
  /* La conversación encadena por previous_response_id, como producción, pero
     con una cadena local desechable: el hilo real del cliente (el guardado
     por obtener_response.service) no se lee ni se escribe. */
  let cadena = null;

  console.log(
    `Config ${ID_CONFIG} · contacto ${ID_CLIENTE} · empieza en "${estado}"\n` +
      `(cadena de Responses desechable — no se toca el hilo real del cliente)\n`,
  );

  const alertas = [];

  /* Los turnos de la simulación no se guardan en mensajes_clientes, pero el
     ancla del producto (contextoColumna) se arma leyendo la conversación. Sin
     pasarle este historial, el ancla solo vería la conversación REAL del
     contacto y la prueba no se parecería a producción. Más nuevo primero,
     mismo formato que la consulta de la BD. */
  const historial = [];

  for (const mensaje of MENSAJES) {
    const col = porEstado.get(estado);
    if (!col) {
      console.log(`\n⛔ La columna "${estado}" no tiene IA activa. Fin.`);
      break;
    }

    console.log(`${'─'.repeat(72)}\n🙍 CLIENTE: ${mensaje}\n`);

    const contexto = await construirContextoColumna(
      ID_CONFIG,
      col.acciones,
      null,
      {
        mensaje,
        id_cliente: ID_CLIENTE,
        // El mensaje actual va primero: en producción el webhook ya lo guardó
        // cuando kanban_ia arma el contexto.
        historial: [{ rol_mensaje: 0, texto_mensaje: mensaje }, ...historial],
      },
    );

    /* Mismo freno que producción: IA activa con el prompt vacío no se corre
       (sería un modelo desnudo inventando precios). */
    if (!String(col.instrucciones || '').trim()) {
      console.log(
        `\n⛔ La columna "${col.nombre}" tiene IA activa pero el prompt en BD está vacío (producción tampoco la ejecuta). Fin.`,
      );
      break;
    }

    /* El mensaje va MARCADO al final del contexto, como en producción: pegado
       sin rótulo tras miles de caracteres, un "1" o un "Una" se pierde
       (incidente cfg 366). */
    const input = contexto.trim()
      ? `🧾 Contexto adicional:\n\n${contexto.trim()}\n\n💬 MENSAJE ACTUAL DEL CLIENTE (responde a ESTO):\n${mensaje}`
      : mensaje;

    const turno = await correr(col, input, cadena);
    cadena = turno.response_id || cadena;
    const cruda = turno.texto;

    const tags = TAGS_CUENTA.filter((t) =>
      cruda.toLowerCase().includes(t.toLowerCase()),
    );

    let texto = cruda;
    for (const t of TAGS_CUENTA) texto = texto.split(t).join('');
    const antesFiltro = texto.trim();
    texto = limpiarMarkdown(humanizarFechas(limpiarColetillas(antesFiltro)));
    const partes = dividirRespuestaIA(texto);

    // Al historial en el mismo orden que quedarían en la BD (más nuevo primero).
    historial.unshift({ rol_mensaje: 0, texto_mensaje: mensaje });
    historial.unshift({ rol_mensaje: 1, texto_mensaje: texto });

    console.log(
      `🤖 [${col.nombre} · ${col.modelo} · catálogo ${turno.catalogo}] → ${partes.length} mensaje(s)`,
    );
    partes.forEach((p, i) =>
      console.log(`   ${i + 1}│ ${p.replace(/\n/g, '\n    │ ')}`),
    );

    if (texto !== antesFiltro) console.log('   🧹 se cortó una coletilla');
    console.log(`   ▸ tags: ${tags.length ? tags.join(', ') : 'ninguno'}`);

    // ── Revisiones automáticas de las fallas ya conocidas ──
    const revisar = (cond, aviso) => {
      if (cond) {
        alertas.push(aviso);
        console.log(`   ⚠️  ${aviso}`);
      }
    };

    revisar(
      /\d{4}-\d{2}-\d{2}/.test(texto),
      'escribió una fecha en formato de sistema (2026-08-01)',
    );
    revisar(
      /valoraci[oó]n facial/i.test(texto) && !/valoraci[oó]n/i.test(mensaje),
      'metió la valoración facial sin que se la pidieran',
    );
    revisar(
      /(no dudes|cualquier (cosa|duda)|si (quieres|necesitas|deseas) (saber|m[aá]s)|quedo a tu disposici[oó]n)/i.test(
        texto,
      ),
      'quedó una coletilla de relleno',
    );
    /* "está lleno" no es un error por sí solo: a veces es verdad. Se compara
       contra la agenda real y solo se avisa cuando la hora que rechazó estaba
       libre, que es la falla que veníamos persiguiendo. */
    if (/no (hay |tengo )?(disponibilidad|cupo)|est[aá] (lleno|ocupad)|no est[aá] disponible/i.test(texto)) {
      const horas = [...texto.matchAll(/\b([01]?\d|2[0-3]):([0-5]\d)\b/g)].map(
        (m) => `${String(m[1]).padStart(2, '0')}:${m[2]}`,
      );

      const ocupadas = await db.query(
        `SELECT DATE_FORMAT(CONVERT_TZ(ap.start_utc, '+00:00', '-05:00'), '%H:%i') AS h
           FROM appointments ap
           JOIN calendars c ON c.id = ap.calendar_id
          WHERE c.account_id = ? AND ap.status IN ('Agendado', 'Confirmado')
            AND ap.start_utc > UTC_TIMESTAMP()`,
        { replacements: [ID_CONFIG], type: db.QueryTypes.SELECT },
      );
      const setOcupadas = new Set(ocupadas.map((o) => o.h));

      // La hora rechazada es la primera que nombra; las siguientes suelen ser
      // las alternativas que ofrece.
      const rechazada = horas[0];
      if (rechazada && !setOcupadas.has(rechazada)) {
        revisar(true, `dijo que ${rechazada} no está disponible y en la agenda está libre`);
      } else if (rechazada) {
        console.log(`   ✔️  dijo que ${rechazada} está ocupada y es cierto`);
      }
    }
    revisar(
      /\*\*/.test(texto) || /^#{1,6}\s/m.test(texto),
      'quedó Markdown que WhatsApp no entiende',
    );


    /* Mismo enrutado determinista que hace kanban_ia.service: si el mensaje
       nombra un producto del catálogo con intención de compra, la ficha va a
       'venta_producto' aunque el modelo no haya escrito el tag. */
    const tieneDestinoProducto = col.acciones.some((ac) => {
      const c = typeof ac.config === 'string' ? JSON.parse(ac.config || '{}') : ac.config || {};
      return c.estado_destino === 'venta_producto';
    });

    if (tieneDestinoProducto && !tags.includes('[venta_producto]:true')) {
      const RE_COMPRA =
        /\b(compr|quiero la|quiero el|me la llevo|me lo llevo|cu[aá]nto (cuesta|vale|sale)|precio|venden|tienen|c[oó]mo la consigo)/i;
      if (RE_COMPRA.test(mensaje)) {
        const prods = await db.query(
          `SELECT nombre FROM productos_chat_center
             WHERE id_configuracion = ? AND eliminado = 0
               AND LOWER(COALESCE(tipo, '')) NOT LIKE 'servicio%'`,
          { replacements: [ID_CONFIG], type: db.QueryTypes.SELECT },
        );
        const norm = (x) =>
          String(x || '').toLowerCase().normalize('NFD')
            .replace(/\p{M}/gu, '').replace(/[^a-z0-9\s]/g, ' ')
            .replace(/\s+/g, ' ').trim();
        const palabras = norm(mensaje).split(' ').filter((w) => w.length > 3);
        const nombrado = prods.find((pr) => {
          const tk = norm(pr.nombre).split(' ').filter((t) => t.length > 3);
          return tk.filter((t) => palabras.includes(t)).length >= Math.min(2, tk.length);
        });
        if (nombrado) {
          estado = 'venta_producto';
          console.log(
            `   🛍️  enrutado por código: nombró "${nombrado.nombre}" con intención de compra → venta_producto`,
          );
        }
      }
    }

    /* Mismo freno que kanban_ia.service: si la columna de entrada promete una
       cita que no puede crear y no marca el tag, la ficha se deriva igual a la
       etapa que sí agenda. */
    const accionAgenda = col.acciones
      .map((ac) =>
        typeof ac.config === 'string' ? JSON.parse(ac.config || '{}') : ac.config || {},
      )
      .find((c) => c.estado_destino === 'califica');
    const puedeAgendar = col.acciones.some((a) => a.tipo_accion === 'agendar_cita');

    if (accionAgenda && !puedeAgendar && !tags.length) {
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
      if (PROMETE_CITA.test(cruda)) {
        estado = accionAgenda.estado_destino;
        console.log(
          `   ⚠️  prometió una cita sin poder crearla → derivado por código a "${estado}"`,
        );
      }
    }
    // El tag manda a otra columna
    for (const ac of col.acciones) {
      if (ac.tipo_accion !== 'cambiar_estado') continue;
      const conf =
        typeof ac.config === 'string' ? JSON.parse(ac.config || '{}') : ac.config || {};
      if (
        conf.trigger &&
        tags.some((t) => t.toLowerCase() === String(conf.trigger).toLowerCase())
      ) {
        estado = conf.estado_destino;
        console.log(`   ➡️  pasa a "${estado}"`);
      }
    }
    console.log('');
  }

  console.log('═'.repeat(72));
  console.log(
    alertas.length
      ? `⚠️  ${alertas.length} cosa(s) que revisar:\n` +
          alertas.map((a) => `   · ${a}`).join('\n')
      : '✅ Sin fallas conocidas en esta corrida.',
  );
  console.log(`Estado final del contacto: "${estado}"`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('ERROR:', err.response?.data?.error?.message || err.message);
    process.exit(1);
  });
