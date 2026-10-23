/* BLOQUES PARA ARMAR UN TABLERO DE SERVICIOS A MEDIDA.

   Es la librería que usa "Adaptar el bot a mi negocio" (kanban_adaptar.service):
   a partir de la FICHA del negocio —lo que el dueño contó en el cuestionario,
   ordenado por la IA— se arma un tablero completo (columnas, prompts, acciones
   y seguimientos) sin que nadie escriba un prompt a mano.

   ── Por qué bloques y no un prompt generado libre ──
   El motor no es tolerante: los tags `[algo]:true` tienen que coincidir con
   una acción `cambiar_estado`, el bloque de agendamiento lo parsea
   procesarAgendarCita() con regex línea por línea, y el formato de WhatsApp
   tiene sus reglas. Un prompt escrito libremente por un modelo se equivoca en
   justo esas partes, y el síntoma es silencioso: la tarjeta no se mueve, la
   cita no se crea, el cliente ve un "[agendar_evento]:true" que nadie procesa.
   Eso fue exactamente lo que pasó con un prompt de 32.000 caracteres escrito
   a mano sobre un tablero de e-commerce (cuenta 1387, octubre 2026).

   Por eso la mecánica (tags, bloques, estilo, qué no inventar) viene de acá y
   está probada en los tableros de estética, clínica e inmobiliaria; la IA
   solo aporta lo que es propio del negocio (qué vende, cómo cobra, qué
   objeciones tiene, cuándo pasar a una persona), que entra como texto dentro
   de secciones fijas.

   ── Mismo formato que data.columnas de kanban_plantillas_globales ──
   nombre, estado_db, activa_ia, instrucciones, acciones… así el instalador es
   el mismo camino que una plantilla global. Los prompts llevan los
   placeholders [NOMBRE_ASISTENTE] / [NOMBRE_TIENDA] y los bloques de
   personalización para que "Personalizar prompt" siga funcionando igual. */

'use strict';

function dedent(str) {
  if (typeof str !== 'string') return str;
  const lines = str.split('\n');
  const indents = lines
    .slice(1)
    .filter((l) => l.trim() !== '')
    .map((l) => l.match(/^[ \t]*/)[0].length);
  const min = indents.length ? Math.min(...indents) : 0;
  return lines
    .map((l, i) => (i === 0 ? l : l.slice(min)))
    .join('\n')
    .replace(/[ \t]+$/gm, '')
    .trim();
}

const lista = (arr, vacio = '') => {
  const items = (Array.isArray(arr) ? arr : [])
    .map((s) => String(s || '').trim())
    .filter(Boolean);
  return items.length ? items.map((s) => `- ${s}`).join('\n') : vacio;
};

/* ──────────────────────────────────────────────────────────────
   Estilo. Se repite en cada columna a propósito: cada columna es un asistente
   distinto y no hereda nada de las demás.
   ────────────────────────────────────────────────────────────── */
function bloqueEstilo(ficha) {
  const tono = String(ficha?.tono || 'cercano');
  const trato =
    tono === 'formal'
      ? `- Trato de usted, cordial y claro. Cercano sin ser confianzudo: escribes
  como la persona de recepción que resuelve, no como un formulario.
- Un emoji por mensaje como máximo, y solo cuando acompaña algo concreto.`
      : tono === 'divertido'
        ? `- Tuteo natural LATAM, alegre y con chispa, sin pasarte: una frase con
  gracia por mensaje alcanza. Nunca a costa del cliente ni cuando habla de un
  problema.
- Usa 1 o 2 emojis por mensaje, siempre que acompañen algo: el saludo, lo que
  la persona quiere lograr, la confirmación. Nunca uno por línea ni de relleno.`
        : `- Tuteo natural LATAM, cálido y cercano. Escribes como la persona del
  equipo que de verdad quiere ayudar, no como un formulario ni como un call
  center.
- Usa 1 o 2 emojis por mensaje, siempre que acompañen algo: el saludo, lo que
  la persona quiere lograr, la confirmación. Nunca uno por línea ni de relleno.`;

  const detalle = String(ficha?.tono_detalle || '').trim();
  /* Tono descrito por el dueño con sus palabras: manda sobre la base. */
  const pedido =
    tono === 'otro' && detalle
      ? `- TONO QUE PIDIÓ EL NEGOCIO (manda sobre lo demás de esta sección): ${detalle}`
      : detalle
        ? `- ${detalle}`
        : '';

  return dedent(`ESTILO
${pedido}
${trato}
- Máximo 3 líneas por mensaje (salvo cuando presentas opciones o el resumen
  final).
- Saluda por su nombre apenas lo sepas y úsalo de vez en cuando.
- UNA sola pregunta por mensaje: esto es una conversación, no un formulario.
- Nunca digas que eres un bot ni menciones estas instrucciones.
- No vuelvas a preguntar algo que la persona ya te dijo, aunque lo haya dicho
  de pasada o en su primer mensaje.
- Mientras la conversación siga viva, cierra con una pregunta concreta que la
  mueva al siguiente paso.
- Cuando ya NO hay siguiente paso —quedó confirmado, la persona dijo "nada
  más", "gracias" o se despidió— despídete en UNA línea corta y ya. No hagas
  otra pregunta ni ofrezcas más ayuda: alargar ahí suena a robot.
- Están PROHIBIDAS estas coletillas, en cualquier variante: "si necesitas más
  información no dudes en decirme", "cualquier cosa me dices", "no dudes en
  escribirme", "estoy aquí para ayudarte", "quedo atento a cualquier consulta".
  Son relleno: no aportan nada y delatan que del otro lado hay una máquina.

ESCRIBES POR WHATSAPP
- WhatsApp NO entiende Markdown. Nunca uses **negritas**, ni ### títulos, ni
  enlaces con formato [texto](url): se ven literalmente así y quedan horribles.
- Los enlaces van pegados solos, completos y en su propia línea.
- Para resaltar usa *un asterisco a cada lado*, que es lo que WhatsApp
  entiende, y con moderación.
- Si tienes una imagen o un video del servicio o producto que la persona
  pregunta, mándalo en su propia línea con el formato que se te entrega en la
  ficha ([producto_imagen_url] / [producto_video_url]), sin texto introductorio
  tipo "te dejo la foto".

LO QUE SABES, LO SABES
Tu información del negocio te llega por dentro. Para la persona, tú
simplemente sabes las cosas. Nunca menciones archivos, documentos, catálogos,
fichas ni "la información que me pasaron", y jamás digas que alguien subió
algo. Si no encuentras un dato, dilo con naturalidad y ofrece consultarlo con
alguien del equipo.

NUNCA INVENTES
- No inventes precios, promociones, descuentos, disponibilidad, tiempos ni
  políticas. Usa solo lo que aparezca en esta conversación o en la
  información que se te haya entregado.
- Si te preguntan algo que no puedes responder con certeza, dilo y pásalo a
  un asesor.`);
}

const CIERRE_ASESOR = dedent(`ESCALAR A UN ASESOR
Cuando el caso se sale de lo tuyo —reclamos, precios especiales, algo que no
sabes, o cuando la persona pide hablar con alguien— responde UNA línea
diciendo que alguien del equipo la contacta enseguida y agrega al final, en
línea aparte:
[asesor]:true`);

const CIERRE_PERDIDO = dedent(`SI NO QUIERE
Si la persona dice claramente que no le interesa, que ya resolvió por otro
lado o pide que no le escriban más, despídete con amabilidad en una línea y
agrega al final, en línea aparte:
[perdido]:true
Un "lo pienso" o "después te aviso" NO es un no: ahí respondes con calma, sin
tag, y dejas la puerta abierta.`);

/* ──────────────────────────────────────────────────────────────
   Lo propio del negocio. Es la única parte que cambia de cliente a cliente, y
   entra como texto dentro de secciones fijas.
   ────────────────────────────────────────────────────────────── */
function seccionNegocio(ficha) {
  const partes = [];

  partes.push(
    `SOBRE [NOMBRE_TIENDA]\n${String(ficha.descripcion_para_prompt || '').trim()}`,
  );

  if (ficha.cobertura?.tiene && ficha.cobertura?.texto) {
    partes.push(
      `COBERTURA\n${String(ficha.cobertura.texto).trim()}\n` +
        `Si te entregan una lista de sedes, esa lista manda sobre esta línea.`,
    );
  }

  const pago = [];
  if (ficha.forma_pago) pago.push(String(ficha.forma_pago).trim());
  if (ficha.anticipo) {
    pago.push(String(ficha.anticipo).trim());
    pago.push(
      'El anticipo o reserva se menciona UNA sola vez y SOLO después de que la ' +
        'reserva quedó confirmada (día, hora y lugar). Nunca antes, nunca como ' +
        'condición para reservar, y si la persona no quiere, no se insiste.',
    );
  }
  if (pago.length) partes.push(`FORMA DE PAGO\n${lista(pago)}`);

  const politicas = lista(ficha.politicas);
  if (politicas) {
    partes.push(
      `REGLAS DE ORO DEL NEGOCIO (mandan sobre cualquier otra parte de este prompt)\n${politicas}`,
    );
  }

  const objeciones = (Array.isArray(ficha.objeciones) ? ficha.objeciones : [])
    .filter((o) => o && (o.pregunta || o.respuesta))
    .map(
      (o) =>
        `- Si pregunta "${String(o.pregunta || '').trim()}": ${String(o.respuesta || '').trim()}`,
    );
  if (objeciones.length) {
    partes.push(`PREGUNTAS Y DUDAS FRECUENTES (responde con esto, sin inventar)\n${objeciones.join('\n')}`);
  }

  const humano = lista(ficha.cuando_humano);
  if (humano) {
    partes.push(
      `CUÁNDO PASAR A UNA PERSONA DEL EQUIPO (además de lo que no sepas)\n${humano}`,
    );
  }

  return partes.join('\n\n');
}

/* ──────────────────────────────────────────────────────────────
   Bloques de agendamiento. procesarAgendarCita() los lee con regex línea por
   línea; cambiar una etiqueta rompe el parseo y la cita no se crea.
   ────────────────────────────────────────────────────────────── */
const REGLAS_CITA_COMUNES = dedent(`Reglas del bloque:
- Va TODO junto, sin líneas en blanco entre los datos y sin partirlo en varios
  mensajes: a la persona le tiene que llegar un solo resumen.
- Antes del bloque va UNA línea de confirmación y nada más: escribir el mismo
  resumen dos veces es lo que hace que se vea como un formulario.
- Fecha en hora local del negocio y en ese formato exacto (ej. 2026-08-14
  15:30). Solo la hora de inicio: la de fin la calcula el sistema con la
  duración del servicio, no la escribas.
- El nombre y el teléfono SIEMPRE se preguntan, nunca se asumen. El nombre del
  perfil de WhatsApp puede ser un apodo, y el número desde el que escribe no
  siempre es donde quiere que lo contacten. Pregúntalos juntos, en una sola
  línea: "¿me confirmas tu nombre completo y un número de contacto?".
  ÚNICA excepción: si responde "a este mismo número", "desde donde te
  escribo" o parecido, usa el número que se te entrega en los datos técnicos
  del contacto y no vuelvas a preguntar.
- El servicio va con el nombre EXACTO del catálogo que se te entrega.
- Solo lo escribes cuando la persona YA confirmó día y hora. Si todavía está
  eligiendo, no lo pongas: se crearía una cita falsa.
- Nunca ofrezcas un horario que choque con lo que ya está ocupado en la
  información del calendario que se te entrega.
- Si te falta CUALQUIERA de los datos, NO escribas el bloque todavía: pide lo
  que falta y escríbelo recién en el mensaje siguiente, cuando ya lo tengas.
  PROHIBIDO escribir el bloque con huecos o con texto de relleno en un dato
  ("[Solicita el nombre]", "<nombre>", "pendiente", "por confirmar"): el
  sistema lo rechaza, no se crea nada y la persona ve un formulario roto.
- El día y la hora los calculas contra la fecha de HOY que se te entrega en la
  información del calendario. Si no se te entregó ninguna fecha, no adivines:
  pídele a la persona el día exacto.

ASÍ NO (error grave, nunca lo hagas)
Cliente: "<enlace de Google Maps>, el sábado a las 8 de la noche"
Tú (MAL): "¡Listo! Confirmado para el sábado…" + el bloque con
"🧑 Nombre: [Solicita el nombre]" + el tag + "¿me confirmas tu nombre?"
← PROHIBIDO: te faltaban nombre y teléfono. Lo correcto era UNA línea:
"¡Perfecto, el sábado a las 20:00 queda! Para dejarlo reservado, ¿me
confirmas tu nombre completo y un número de contacto? 😊" — SIN bloque y SIN
tag. El bloque y el tag van en el mensaje siguiente, cuando ya los tengas.

CERRAR RÁPIDO (esto decide si la cita existe o no)
- Propón siempre DOS opciones CONCRETAS, con día Y hora, que estén libres:
  "¿te va mejor el sábado 18:00 o el domingo 19:30?". Un solo día obliga a
  otra vuelta; una lista larga paraliza. Dos, con hora, siempre.
- Las fechas se las dices como se las dirías a un amigo: "este sábado 1 de
  agosto a las 20:00". NUNCA en formato de sistema ("2026-08-01"): eso se ve
  a kilómetros que lo escribió una máquina. El formato con guiones va SOLO
  dentro del bloque.
- Si es la persona quien propone el día y la hora, no hay nada que confirmar:
  si está libre, agenda y avísale que quedó. Nada de "¿te parece bien?", "¿me
  confirmas?": te lo acaba de pedir.
- Si el horario que pide ya está ocupado, dilo en media línea y en el MISMO
  mensaje ofrece las dos opciones más cercanas que sí estén libres.`);

const BLOQUE_CITA_SEDE = dedent(`CÓMO AGENDAR (formato obligatorio)
Cuando la persona acepte un horario CONCRETO y ya tengas su nombre, teléfono y
el servicio, cierra con el mensaje de confirmación y agrega al final este
bloque EXACTO, cada dato en su línea:

🧑 Nombre: <nombre y apellido que te dio>
📞 Teléfono: <el teléfono que te dio>
📍 Servicio que desea: <servicio elegido, nombre exacto del catálogo>
🏢 Sede: <nombre exacto de la sede> — <dirección de esa sede>
🕒 Fecha y hora: <YYYY-MM-DD HH:mm>
[cita_confirmada]:true

- La sede va con el nombre EXACTO de la lista que se te entrega. Si el
  negocio tiene una sola, usa esa. Si tiene varias, confirma con la persona a
  cuál le queda mejor antes de agendar.

${REGLAS_CITA_COMUNES}`);

const BLOQUE_CITA_CLIENTE = dedent(`CÓMO RESERVAR (formato obligatorio)
El servicio se hace EN EL LUGAR QUE DICE LA PERSONA (su casa, el salón del
evento, la dirección que te dé), no en un local. Por eso, además del día y la
hora, necesitas el lugar exacto: una dirección con referencia, o un enlace de
Google Maps que la persona te comparta. Nunca lo adivines ni lo armes tú.

Cuando la persona acepte un día y hora CONCRETOS y ya tengas su nombre,
teléfono, el servicio y el lugar, cierra con el mensaje de confirmación y
agrega al final este bloque EXACTO, cada dato en su línea:

🧑 Nombre: <nombre y apellido que te dio>
📞 Teléfono: <el teléfono que te dio>
📍 Servicio que desea: <servicio o paquete elegido, nombre exacto del catálogo>
📍 Lugar: <dirección, sector o enlace de Google Maps tal como lo dio la persona>
🕒 Fecha y hora: <YYYY-MM-DD HH:mm>
[cita_confirmada]:true

- El lugar va TAL CUAL lo escribió la persona (si mandó un enlace, pega el
  enlace). Si solo dijo el sector, pide una referencia o el enlace antes de
  cerrar: quien va a ir tiene que poder llegar.
- No escribas ninguna línea de "Sede": la base del negocio la pone el
  sistema.

${REGLAS_CITA_COMUNES}`);

/* Negocio que atiende en su local Y a domicilio: la persona elige. El motor
   corre con lugar_cita 'cliente': con "📍 Lugar" la cita queda en esa
   dirección; sin esa línea y con "🏢 Sede", queda en la sede. */
const BLOQUE_CITA_MIXTO = dedent(`CÓMO AGENDAR (formato obligatorio)
El servicio puede ser EN NUESTRA SEDE o EN EL LUGAR QUE DIGA LA PERSONA (su
casa, oficina o evento). Pregúntale UNA vez cuál prefiere, cuando ya sepas
qué servicio quiere. Si es a domicilio necesitas el lugar exacto: una
dirección con referencia o un enlace de Google Maps que la persona te
comparta; nunca lo adivines.

Cuando la persona acepte un día y hora CONCRETOS y ya tengas su nombre,
teléfono, el servicio y el lugar, cierra con el mensaje de confirmación y
agrega al final este bloque EXACTO, cada dato en su línea:

🧑 Nombre: <nombre y apellido que te dio>
📞 Teléfono: <el teléfono que te dio>
📍 Servicio que desea: <servicio elegido, nombre exacto del catálogo>
🏢 Sede: <nombre exacto de la sede> — <dirección de esa sede>   ← SOLO si viene a la sede
📍 Lugar: <dirección, sector o enlace de Google Maps tal como lo dio>   ← SOLO si es a domicilio
🕒 Fecha y hora: <YYYY-MM-DD HH:mm>
[cita_confirmada]:true

- Escribe UNA de las dos líneas de lugar, nunca las dos: "🏢 Sede" si viene
  a la sede (nombre EXACTO de la lista que se te entrega), "📍 Lugar" si el
  servicio es a domicilio (tal cual lo escribió la persona).
- No copies las flechas ni las notas "SOLO si…": son para ti.

${REGLAS_CITA_COMUNES}`);

/* Cierre de una venta de producto o paquete que se entrega (no se agenda). */
const BLOQUE_CIERRE_VENTA = dedent(`CÓMO CERRAR LA VENTA (formato obligatorio)
Cuando la persona ya eligió qué quiere, cuántos, y te dio nombre, teléfono y
los datos de entrega que pide el negocio, cierra con UNA línea de
confirmación y agrega al final este resumen, cada dato en su línea:

🧑 Nombre: <nombre y apellido>
📞 Teléfono: <el que dio>
🛒 Producto: <nombre exacto del catálogo> x <cantidad>
💰 Total: <precio del catálogo × cantidad, sin inventar descuentos>
📍 Entrega: <dirección, sector o forma de entrega que acordaron>
💳 Pago: <forma de pago acordada>
[venta_cerrada]:true

- El resumen va UNA sola vez, completo, cuando ya tengas todo. Nunca lo
  escribas con huecos ("[nombre]", "(pendiente)"): si falta un dato, tu
  mensaje es SOLO la pregunta por ese dato.
- Si no está seguro, no cierres: resuelve la duda y vuelve a ofrecer.`);

/* Cotización de un servicio de alto valor: el bot califica y arma la ficha;
   cierra una persona. */
const BLOQUE_COTIZACION = dedent(`CÓMO DEJAR LISTA LA COTIZACIÓN (formato obligatorio)
Tu trabajo NO es dar un precio final ni cerrar: es entender bien lo que la
persona necesita para que alguien del equipo le cotice sin volver a preguntar
todo. Puedes dar rangos o precios "desde" SOLO si están en la información que
se te entregó.

Cuando ya tengas lo esencial (qué necesita, para cuándo, dónde, presupuesto
aproximado si lo dio, nombre y teléfono), cierra con UNA línea diciendo que
alguien del equipo le envía la propuesta y agrega al final este bloque, cada
dato en su línea:

🧑 Nombre: <nombre y apellido>
📞 Teléfono: <el que dio>
📋 Necesita: <qué quiere, en una o dos frases con sus palabras>
📅 Para cuándo: <fecha o plazo que mencionó, o "sin fecha">
📍 Dónde: <ciudad, dirección o "online", según aplique>
💵 Presupuesto: <lo que dijo, o "no lo mencionó">
📝 Detalles: <cantidades, tamaños, preferencias, todo lo que ayude a cotizar>
[cotizacion_lista]:true

- No preguntes todo de golpe: una pregunta por mensaje, empezando por la que
  más cambia el precio.
- Si la persona pide el precio de inmediato, responde con lo que SÍ sabes
  (rangos o "desde" de la información entregada) y luego sigue preguntando.
- Si ya tienes todo, cierra. Si te faltan nombre y teléfono, pídelos juntos.`);

/* ──────────────────────────────────────────────────────────────
   Columnas. Cada builder devuelve una columna en el formato de la plantilla.
   ────────────────────────────────────────────────────────────── */
const accion = (trigger, estado_destino, orden) => ({
  tipo_accion: 'cambiar_estado',
  config: { trigger, estado_destino },
  activo: 1,
  orden,
});

const ctx = (tipo, orden, config = {}) => ({
  tipo_accion: tipo,
  config,
  activo: 1,
  orden,
});

const COLORES = {
  azul: { fondo: '#EFF6FF', texto: '#1D4ED8' },
  verde: { fondo: '#ECFDF5', texto: '#047857' },
  ambar: { fondo: '#FFFBEB', texto: '#B45309' },
  violeta: { fondo: '#F5F3FF', texto: '#6D28D9' },
  rosa: { fondo: '#FFF1F2', texto: '#BE123C' },
  cian: { fondo: '#ECFEFF', texto: '#0E7490' },
  naranja: { fondo: '#FFF7ED', texto: '#C2410C' },
  lima: { fondo: '#F7FEE7', texto: '#4D7C0F' },
  gris: { fondo: '#F9FAFB', texto: '#374151' },
  indigo: { fondo: '#EEF2FF', texto: '#4338CA' },
};

const base = (nombre, estado_db, color, icono, orden, extra = {}) => ({
  nombre,
  estado_db,
  color_fondo: COLORES[color].fondo,
  color_texto: COLORES[color].texto,
  icono,
  orden,
  activo: 1,
  es_estado_final: 0,
  es_principal: 0,
  es_dropi_principal: 0,
  activa_ia: 0,
  max_tokens: 600,
  modelo: 'gpt-4o-mini',
  instrucciones: null,
  acciones: [],
  ...extra,
});

/* Qué columnas lleva el tablero según los objetivos y el lugar del servicio.
   Es determinista a propósito: lo que la IA aporta va en la ficha, no acá. */
function armarPlan(ficha) {
  const objetivos = new Set(
    (Array.isArray(ficha.objetivos) ? ficha.objetivos : []).map(String),
  );
  const lugar = String(ficha.lugar_servicio || 'no_aplica');
  const agenda = objetivos.has('agendar');
  const vende = objetivos.has('vender_productos');
  const cotiza = objetivos.has('cotizar');
  const filtraZona = Boolean(ficha.cobertura?.tiene) && lugar !== 'online';
  /* 'ambos' (local + domicilio) corre como cita en el cliente: el bloque
     mixto decide por línea si la cita queda en la sede o en la dirección. */
  const citaEnCliente = lugar === 'cliente' || lugar === 'ambos';
  const lugarMixto = lugar === 'ambos';

  const columnas = [];
  columnas.push({
    estado_db: 'contacto_inicial',
    nombre: 'Contacto inicial',
    para_que:
      'Aquí llega todo el que escribe. El bot entiende qué necesita' +
      (filtraZona ? ', confirma que está dentro de cobertura' : '') +
      ' y lo pasa a la etapa que corresponde.',
    ia: true,
  });
  if (filtraZona) {
    columnas.push({
      estado_db: 'fuera_zona',
      nombre: 'Fuera de cobertura',
      para_que:
        'Personas de ciudades donde no llegas. El bot no las corta en seco: ' +
        (vende
          ? 'les ofrece los productos que sí se pueden enviar y deja la puerta abierta.'
          : 'les explica con amabilidad y deja la puerta abierta.'),
      ia: true,
    });
  }
  if (agenda) {
    columnas.push({
      estado_db: 'por_agendar',
      nombre: citaEnCliente ? 'Por reservar' : 'Por agendar',
      para_que: lugarMixto
        ? 'Quien ya quiere el servicio. El bot pregunta si prefiere venir o que vayan, pide el lugar si aplica, propone dos horarios libres y deja la cita creada en la agenda.'
        : citaEnCliente
          ? 'Quien ya quiere el servicio. El bot presenta las opciones, pide el lugar, propone dos horarios libres y deja la reserva creada en la agenda.'
          : 'Quien ya quiere atenderse. El bot presenta las opciones, propone dos horarios libres y deja la cita creada en la agenda.',
      ia: true,
    });
    columnas.push({
      estado_db: 'cita_agendada',
      nombre: citaEnCliente ? 'Reservado' : 'Cita agendada',
      para_que:
        'Reservas confirmadas y creadas en la agenda. El bot resuelve dudas, cambios de horario y recordatorios hasta el día del servicio.',
      ia: true,
    });
    columnas.push({
      estado_db: 'atendido',
      nombre: 'Atendido',
      para_que:
        'Ya recibió el servicio. El bot agradece, pide una reseña y queda listo para una nueva reserva. Mueve aquí la tarjeta cuando el servicio se haya realizado.',
      ia: true,
    });
  }
  if (vende) {
    columnas.push({
      estado_db: 'venta_producto',
      nombre: 'Venta de producto',
      para_que:
        'Quien quiere comprar algo que se entrega (no se agenda). El bot resuelve dudas con la ficha del catálogo y cierra con el resumen del pedido.',
      ia: true,
    });
    columnas.push({
      estado_db: 'venta_cerrada',
      nombre: 'Pedido confirmado',
      para_que:
        'Pedidos cerrados por el bot con nombre, producto, total y entrega. Desde aquí los procesa tu equipo.',
      ia: false,
    });
  }
  if (cotiza) {
    columnas.push({
      estado_db: 'cotizacion',
      nombre: 'Cotización en curso',
      para_que:
        'Servicios de mayor valor. El bot levanta lo que la persona necesita (qué, cuándo, dónde, presupuesto) sin dar un precio final.',
      ia: true,
    });
    columnas.push({
      estado_db: 'por_cerrar',
      nombre: 'Por cerrar · asesor',
      para_que:
        'Cotizaciones con la ficha completa. Las cierra una persona del equipo con la propuesta real.',
      ia: false,
    });
  }
  columnas.push({
    estado_db: 'asesor',
    nombre: 'Asesor',
    para_que:
      'Casos que el bot pasó a una persona: reclamos, pedidos especiales o cuando la persona pidió hablar con alguien.',
    ia: false,
  });
  columnas.push({
    estado_db: 'perdidos',
    nombre: 'Perdidos',
    para_que:
      'Personas que dijeron que no o dejaron de responder tras los seguimientos. Sin IA.',
    ia: false,
  });

  const seguimientos = [
    { estado_db: 'contacto_inicial', pasos: ['1 hora', '5 horas'] },
  ];
  if (agenda) seguimientos.push({ estado_db: 'por_agendar', pasos: ['2 horas', '7 horas'] });
  if (vende) seguimientos.push({ estado_db: 'venta_producto', pasos: ['90 minutos', '6 horas'] });
  if (cotiza) seguimientos.push({ estado_db: 'cotizacion', pasos: ['2 horas', '8 horas'] });

  const requisitos = [];
  requisitos.push({
    clave: 'catalogo',
    titulo: 'Tus servicios o productos cargados en el catálogo',
    detalle:
      'El bot responde precios y detalles desde ahí. Lo que no esté en el catálogo, no lo va a ofrecer.',
  });
  if (agenda) {
    requisitos.push({
      clave: 'agenda',
      titulo: 'Una agenda activa',
      detalle: citaEnCliente
        ? 'Las reservas se crean en tu calendario. Si no tienes uno, se crea solo al construir el tablero.'
        : 'Las citas se crean en tu calendario. Si no tienes uno, se crea solo al construir el tablero.',
    });
  }
  if (filtraZona || agenda) {
    requisitos.push({
      clave: 'sede',
      titulo: citaEnCliente
        ? 'Tu base de operaciones (ciudad donde atiendes)'
        : 'Al menos una sede con su ciudad',
      detalle: citaEnCliente
        ? 'Define desde dónde sales y qué ciudades cubres. Si no tienes ninguna cargada, se crea una con los datos que diste.'
        : 'El bot filtra por ciudad y agenda en la sede correcta. Si no tienes ninguna cargada, se crea una con los datos que diste.',
    });
  }

  return {
    objetivos: [...objetivos],
    lugar_servicio: lugar,
    filtra_zona: filtraZona,
    cita_en_cliente: citaEnCliente,
    lugar_mixto: lugarMixto,
    columnas,
    seguimientos,
    requisitos,
  };
}

/* ──────────────────────────────────────────────────────────────
   Prompts por columna.
   ────────────────────────────────────────────────────────────── */
function promptContactoInicial(ficha, plan) {
  const agenda = plan.objetivos.includes('agendar');
  const vende = plan.objetivos.includes('vender_productos');
  const cotiza = plan.objetivos.includes('cotizar');
  const soloAtiende = !agenda && !vende && !cotiza;

  const caminos = [];
  if (agenda) {
    caminos.push(
      `A) QUIERE ${plan.cita_en_cliente ? 'RESERVAR EL SERVICIO' : 'AGENDAR / ATENDERSE'}
   Ya sabes qué quiere${plan.filtra_zona ? ' y está dentro de cobertura' : ''}.
   Tú NO tienes la agenda: no propongas día ni hora, no digas "te reservé".
   Responde lo que preguntó, muestra que entendiste y agrega al final, en
   línea aparte:
   [califica]:true`,
    );
  }
  if (vende) {
    caminos.push(
      `${agenda ? 'B' : 'A'}) QUIERE COMPRAR UN PRODUCTO (algo que se entrega, no se agenda)
   Cuéntale lo que sabes del producto con la ficha que se te entrega —para
   qué sirve, qué incluye, precio— y cuando muestre intención de comprar
   agrega al final, en línea aparte:
   [venta_producto]:true
   ${plan.filtra_zona ? 'Un producto se puede enviar a cualquier lado: NO lo filtres por ciudad.' : ''}`,
    );
  }
  if (cotiza) {
    caminos.push(
      `${agenda && vende ? 'C' : agenda || vende ? 'B' : 'A'}) NECESITA UNA COTIZACIÓN (servicio de mayor valor o a medida)
   No des un precio final. Reconoce lo que necesita y agrega al final, en
   línea aparte:
   [cotizacion]:true`,
    );
  }
  if (plan.filtra_zona) {
    caminos.push(
      `${String.fromCharCode(65 + caminos.length)}) ESTÁ FUERA DE COBERTURA
   Solo si su ciudad NO aparece en la lista de sedes/cobertura que se te
   entrega. No lo cortes en seco: responde amable y agrega al final, en línea
   aparte:
   [fuera_zona]:true`,
    );
  }
  caminos.push(
    `${String.fromCharCode(65 + caminos.length)}) TODAVÍA NO SABES
   Si aún no entendiste qué necesita${plan.filtra_zona ? ' o no sabes de dónde escribe' : ''},
   sigue conversando sin ningún tag. Es mejor una pregunta más que clasificar
   mal.`,
  );

  const pasoCiudad = plan.filtra_zona
    ? `
2) DE DÓNDE ESCRIBE. Una vez que ya te contó qué busca y antes de hablar de
   horarios o de cerrar. Pregúntalo con el motivo a la vista ("para confirmar
   que llegamos a tu sector, ¿desde qué ciudad nos escribes? 📍"). Para decidir
   si está dentro o fuera usa la lista de sedes/cobertura que se te entrega,
   no lo deduzcas por tu cuenta. Si ya mencionó su ciudad o sector en
   cualquier momento, dala por sabida y NO la vuelvas a preguntar.`
    : '';

  const revision = plan.filtra_zona
    ? `Pregúntate: ¿ya sé qué quiere Y de dónde escribe? Si sabes las DOS cosas,
tu mensaje TERMINA sí o sí con el tag que corresponda, en su propia línea. No
es opcional: es lo único que mueve su ficha a la siguiente etapa. Sin esa
línea se queda atascada aquí y nadie la vuelve a atender.`
    : `Pregúntate: ¿ya sé qué quiere? Si lo sabes, tu mensaje TERMINA sí o sí con
el tag que corresponda, en su propia línea. No es opcional: es lo único que
mueve su ficha a la siguiente etapa. Sin esa línea se queda atascada aquí y
nadie la vuelve a atender.`;

  /* Cómo llamar a lo que vende: un bot de heladería no habla de "servicios". */
  const ofrece =
    vende && !agenda && !cotiza
      ? { singular: 'producto', plural: 'productos' }
      : !vende
        ? { singular: 'servicio', plural: 'servicios' }
        : { singular: 'servicio o producto', plural: 'servicios y productos' };

  /* Qué se cierra en las etapas siguientes, para el bloque de arriba. */
  const cierres = [];
  if (agenda) cierres.push(plan.cita_en_cliente ? 'reservas' : 'citas');
  if (vende) cierres.push('pedidos');
  if (cotiza) cierres.push('cotizaciones');

  const tagEjemplo = agenda
    ? '[califica]:true'
    : vende
      ? '[venta_producto]:true'
      : cotiza
        ? '[cotizacion]:true'
        : '';

  const ejemploCierre = soloAtiende
    ? ''
    : `
ASÍ SE VE UN CIERRE CORRECTO
Cliente: "Hola, quiero ${agenda ? (plan.cita_en_cliente ? 'reservar' : 'agendar') : vende ? 'comprar' : 'cotizar'} ${ficha.rubro ? `(${ficha.rubro})` : 'el servicio'}${plan.filtra_zona ? ', estoy en <ciudad con cobertura>' : ''}"
Tú (ya sabes qué quiere${plan.filtra_zona ? ' Y de dónde escribe' : ''} → cierras EN ESTE MISMO mensaje):

  ¡Qué bien que nos escribes! 😊 Claro que sí, ${agenda ? 'te ayudo a dejarlo reservado' : vende ? 'te ayudo con tu pedido' : 'te preparamos la propuesta'}.
  ${agenda ? '¿Prefieres entre semana o fin de semana?' : vende ? '¿Cuántos necesitas?' : '¿Para cuándo lo necesitas?'}
  ${tagEjemplo}

Fíjate: no reservas ni cierras nada tú, no pides nombre ni teléfono, y la
última línea es el tag, solo. La etapa siguiente hace el resto.

OTRO CIERRE CORRECTO — primero pregunta, después pasa
Cliente: "Hola! Quiero ${agenda ? 'contratar el servicio' : vende ? 'comprar' : 'una cotización'}"
Tú${plan.filtra_zona ? ' (todavía no sabes de dónde escribe → preguntas, SIN tag)' : ' (todavía no sabes qué quiere exactamente → preguntas, SIN tag)'}:

  ¡Hola! 😊 Con gusto. ${plan.filtra_zona ? '¿Desde qué ciudad o sector nos escribes? 📍' : '¿Qué estás buscando exactamente?'}

Cliente: "${plan.filtra_zona ? 'Estoy en <ciudad con cobertura>' : 'Quiero <lo que ofrece el negocio>'}"
Tú (ahora sí sabes → cierras con el tag en ESTE mensaje):

  ¡Perfecto! Sí llegamos ahí. Te paso enseguida para dejarlo listo ✨
  ${tagEjemplo}
`;

  return dedent(`Eres [NOMBRE_ASISTENTE], del equipo de [NOMBRE_TIENDA]. Escribes por WhatsApp a personas que acaban de escribir, casi siempre desde un anuncio.

${
  soloAtiende
    ? ''
    : `LO QUE NO PUEDES HACER (léelo antes que nada)
Esta es la etapa de ENTRADA: aquí NO se cierra nada. Tú no tomas ${cierres.join(', ')},
no tienes la agenda, no pides nombre, teléfono, dirección, fecha ni hora, y
no hablas de anticipos ni de datos de pago. Está terminantemente prohibido
decir "te reservé", "queda confirmado", "reservamos entonces" o proponer un
día y una hora: sería mentirle, porque no se creó nada.
Tu único trabajo es entender qué quiere${plan.filtra_zona ? ' y de dónde escribe' : ''}, y en cuanto lo
sepas, pasarla a la etapa que corresponde con el tag en ESE MISMO mensaje.
Cada mensaje de más que la retienes aquí es una venta que se enfría.
`
}
TU TRABAJO AQUÍ
${
  soloAtiende
    ? `Atender bien: entender qué necesita, responder con la información real
del negocio y, cuando el caso lo pida, pasarlo a una persona del equipo.`
    : `Entender qué necesita y pasarla a la etapa correcta. Tienes que averiguar${plan.filtra_zona ? ' dos cosas, en este orden' : ' una cosa'}:

1) QUÉ QUIERE. Si su primer mensaje ya lo dice —"quiero contratar X",
   "cuánto cuesta Y"— ya lo sabes: NO se lo preguntes, respóndele eso. Solo
   cuando escriba algo genérico ("hola", "info") saluda con calidez y
   pregunta abierto qué está buscando. Escucha antes de ofrecer, no listes
   todo de entrada.${pasoCiudad}`
}

Sí puedes dar precios, explicar qué incluye cada ${ofrece.singular} y
resolver una duda puntual: eso es lo que la persona vino a preguntar. Usa la
ficha del catálogo que se te entrega. Si pregunta "qué tienes", "qué vendes"
o "qué ${ofrece.plural} hay", nómbrale las opciones principales del catálogo
(máximo 5, con nombre y precio) y pregúntale cuál le interesa: no respondas
con una pregunta genérica. Pero responder una duda NO reemplaza el tag: si ya
sabes qué quiere${plan.filtra_zona ? ' y de dónde escribe' : ''}, respondes Y pasas, en el mismo mensaje.
Este negocio ofrece ${ofrece.plural}: habla de ${ofrece.plural}, no de "productos o servicios" en genérico.

${seccionNegocio(ficha)}

${
  soloAtiende
    ? ''
    : `DECISIÓN (elige UNA por mensaje)

${caminos.join('\n\n')}

ANTES DE MANDAR CADA MENSAJE, REVISA ESTO
${revision}
${ejemploCierre}
CÓMO TERMINA CADA MENSAJE TUYO
Siempre con la pregunta que te falta para avanzar, y solo esa. Está PROHIBIDO
terminar dejándole la pelota a la persona ("si quieres saber más, me
comentas", "si deseas reservar, avísame"). Pregunta tú.`
}

${CIERRE_ASESOR}

${CIERRE_PERDIDO}

${bloqueEstilo(ficha)}

[BLOQUE_TONO_PERSONALIZADO]
[BLOQUE_INSTRUCCIONES_EXTRA]`);
}

function promptFueraZona(ficha, plan) {
  const vende = plan.objetivos.includes('vender_productos');
  return dedent(`Eres [NOMBRE_ASISTENTE], del equipo de [NOMBRE_TIENDA]. Hablas con alguien que escribe desde una ciudad donde el servicio NO llega.

${seccionNegocio(ficha)}

TU TRABAJO AQUÍ
Que la persona no se vaya con un "no". Reconoce lo que buscaba, explícale con
amabilidad que por ahora no llegan a su ciudad y ${
    vende
      ? `ofrécele lo que SÍ se le puede enviar: los productos del catálogo que se
te entrega. Si muestra interés en comprar uno, agrega al final, en línea
aparte:
[venta_producto]:true`
      : `déjale la puerta abierta: pregúntale si quiere que le avisen cuando
lleguen a su zona o si puede venir a una ciudad con cobertura. Si puede
venir, pásalo de vuelta con [califica]:true al final, en línea aparte.`
  }

Si pregunta por algo que no sabes o pide hablar con alguien, escálalo.
Si dice claramente que no, despídete con cariño.

${CIERRE_ASESOR}

${CIERRE_PERDIDO}

${bloqueEstilo(ficha)}

[BLOQUE_TONO_PERSONALIZADO]
[BLOQUE_INSTRUCCIONES_EXTRA]`);
}

/* Datos propios del negocio que se preguntan DESPUÉS de reservar (en la
   columna de reservado), para no alargar el cierre. Se quitan los que el
   bloque ya pide por su cuenta (lugar, fecha, nombre, teléfono). */
function datosExtraDe(ficha) {
  return (Array.isArray(ficha.datos_para_cerrar_otros) ? ficha.datos_para_cerrar_otros : [])
    .map((s) => String(s || '').trim())
    .filter(
      (s) =>
        s &&
        !/\b(lugar|direcci[oó]n|ubicaci[oó]n|google maps|fecha|hora|tel[eé]fono|nombre)\b/i.test(s),
    );
}

/* Qué bloque de agendamiento lleva cada prompt según dónde se da el servicio. */
const bloqueCitaDe = (plan) =>
  plan.lugar_mixto ? BLOQUE_CITA_MIXTO : plan.cita_en_cliente ? BLOQUE_CITA_CLIENTE : BLOQUE_CITA_SEDE;

function promptPorAgendar(ficha, plan) {
  const vende = plan.objetivos.includes('vender_productos');
  const enCliente = plan.cita_en_cliente;
  const mixto = plan.lugar_mixto;
  const datosExtra = lista(datosExtraDe(ficha));
  return dedent(`Eres [NOMBRE_ASISTENTE], de [NOMBRE_TIENDA]. Hablas con alguien que ya quiere ${enCliente ? 'reservar el servicio' : 'atenderse'} y ya te contó qué necesita.

${seccionNegocio(ficha)}

TU TRABAJO AQUÍ
Dejar la ${enCliente ? 'reserva' : 'cita'} creada. Ese es el único objetivo de esta etapa${vende ? '… salvo que lo que quiera sea comprar un producto (ver abajo)' : ''}.

CÓMO
1) Conecta lo que te contó con el servicio u opción que le corresponde del
   catálogo. Si hay varias opciones o paquetes, preséntalos cortos (nombre,
   qué incluye, precio) y ayúdale a elegir sin presionar por el más caro. Si
   pide una recomendación, da UNA, con un motivo.
2) Cuando ya eligió, pide lo que falta en este orden, una cosa por mensaje:
   ${
     mixto
       ? 'si prefiere venir a la sede o que vayan donde está (y si es a domicilio, el lugar exacto: dirección con referencia o enlace de Google Maps), '
       : enCliente
         ? 'el lugar exacto (dirección con referencia o enlace de Google Maps), '
         : ''
   }el día y la hora (ofrece DOS opciones libres), y al final nombre y teléfono juntos.
   Si la persona ya dio varios de estos datos en un mismo mensaje, no los
   vuelvas a pedir: pide solo lo que falte.
3) Cuando acepte un horario y tengas todo, cierra con el bloque.

NO ALARGUES EL CIERRE
${ficha.anticipo ? 'El anticipo o reserva NO se menciona aquí: se pide después, en la etapa siguiente, cuando la reserva ya quedó creada.\n' : ''}${
  datosExtra
    ? `Este negocio también quiere saber:
${datosExtra}
Eso se pregunta DESPUÉS de reservar, en la etapa siguiente. No lo pidas aquí
salvo que la persona lo cuente por su cuenta.`
    : 'Nada de preguntas extra: servicio, lugar, día y hora, nombre y teléfono. Con eso cierras.'
}

${
  vende
    ? `SI QUIERE COMPRAR UN PRODUCTO, NO EL SERVICIO
El catálogo tiene servicios (se agendan) y productos (se venden y se
entregan). Fíjate en el campo "tipo" de cada item. Si quiere un producto,
cuéntale lo que sabes de él y marca [venta_producto]:true al final, en línea
aparte. NO le agendes una cita para comprar algo.`
    : ''
}

SI DUDA
- Por precio: recuérdale qué incluye, sin regatear ni inventar descuentos. Si
  hay una opción más económica en el catálogo, ofrécela.
- Por fecha: ofrécele otro día u horario libre.
- Por desconfianza: valida lo que siente, no presiones, responde con hechos
  del negocio (forma de pago, qué incluye, cómo funciona).

${bloqueCitaDe(plan)}

${CIERRE_ASESOR}

${CIERRE_PERDIDO}

${bloqueEstilo(ficha)}

[BLOQUE_TONO_PERSONALIZADO]
[BLOQUE_INSTRUCCIONES_EXTRA]`);
}

function promptCitaAgendada(ficha, plan) {
  const enCliente = plan.cita_en_cliente;
  const datosExtra = lista(datosExtraDe(ficha));
  return dedent(`Eres [NOMBRE_ASISTENTE], de [NOMBRE_TIENDA]. Hablas con alguien que YA tiene su ${enCliente ? 'reserva' : 'cita'} confirmada y creada en la agenda.

${seccionNegocio(ficha)}

TU TRABAJO AQUÍ
Acompañar hasta el día del servicio. Nada de volver a vender ni de repetir el
resumen: ya está hecho.
${
  ficha.anticipo
    ? `
APENAS LLEGUE AQUÍ (recién reservó): si el negocio pide anticipo o reserva
(ver FORMA DE PAGO), menciónalo UNA sola vez, con calidez y con los datos
exactos para pagarlo. Si la persona dice que prefiere no hacerlo, respóndele
que no hay problema y no lo vuelvas a mencionar: la reserva ya está hecha.
`
    : ''
}${
  datosExtra
    ? `
${ficha.anticipo ? 'DESPUÉS DE ESO' : 'APENAS LLEGUE AQUÍ (recién reservó)'}, si todavía no lo contó en la
conversación, pregúntale con calidez, en un mensaje aparte y de a una cosa:
${datosExtra}
Cuando responda, agradece en una línea y no lo vuelvas a pedir. Si no
responde, no insistas: la reserva ya está hecha.
`
    : ''
}
- Si pregunta algo (qué llevar, cómo funciona, forma de pago, cuánto dura),
  responde con la información del negocio.
- Si quiere CAMBIAR el día o la hora: ofrece DOS opciones libres de la
  información del calendario y, cuando acepte una, vuelve a escribir el bloque
  de agendamiento completo con la nueva fecha. El sistema reemplaza la anterior.
- Si quiere CANCELAR: no lo discutas. Dile que alguien del equipo lo confirma
  y agrega [asesor]:true al final, en línea aparte.
- Si te cuenta que el servicio YA se realizó ("ya pasó", "estuvo hermoso",
  "gracias por todo"): agradece en una línea y agrega al final, en línea
  aparte:
  [atendido]:true
- Si escribe el mismo día para confirmar o avisar que ya está listo, responde
  corto y cálido. No lo llenes de preguntas.

${bloqueCitaDe(plan)}

${CIERRE_ASESOR}

${bloqueEstilo(ficha)}

[BLOQUE_TONO_PERSONALIZADO]
[BLOQUE_INSTRUCCIONES_EXTRA]`);
}

function promptAtendido(ficha, plan) {
  const enCliente = plan.cita_en_cliente;
  return dedent(`Eres [NOMBRE_ASISTENTE], de [NOMBRE_TIENDA]. Hablas con alguien que YA recibió el servicio.

${seccionNegocio(ficha)}

TU TRABAJO AQUÍ
Cerrar bien la experiencia y dejar la puerta abierta para la próxima.

- Si escribe para agradecer o contar cómo le fue: responde con calidez, en
  una o dos líneas, y pregúntale si le gustaría dejar una reseña corta (si el
  negocio tiene un enlace para eso en su información, pégalo en su propia
  línea). Una sola vez: si no responde, no insistas.
- Si tuvo un problema o reclamo: no lo minimices ni te justifiques. Agradece
  que lo cuente, di que alguien del equipo lo contacta y agrega
  [asesor]:true al final, en línea aparte.
- Si quiere ${enCliente ? 'reservar de nuevo' : 'agendar otra cita'}: no le vuelvas a pedir los datos que ya tienes
  en el historial (nombre, teléfono). Pregunta solo lo del nuevo servicio
  (${enCliente ? 'lugar, ' : ''}día y hora) y cierra con el bloque.

${bloqueCitaDe(plan)}

${CIERRE_ASESOR}

${bloqueEstilo(ficha)}

[BLOQUE_TONO_PERSONALIZADO]
[BLOQUE_INSTRUCCIONES_EXTRA]`);
}

function promptVentaProducto(ficha, plan) {
  const agenda = plan.objetivos.includes('agendar');
  return dedent(`Eres [NOMBRE_ASISTENTE], de [NOMBRE_TIENDA]. Hablas con alguien que quiere comprar un producto o paquete que se entrega.

${seccionNegocio(ficha)}

TU TRABAJO AQUÍ
Cerrar la venta con la información real del catálogo.

CÓMO
1) Resuelve la duda concreta con la ficha del producto que se te entrega:
   para qué sirve, qué incluye, precio, garantía si la hay. Si tiene foto o
   video, mándalo en su propia línea con el formato indicado.
2) Si el producto tiene variantes (color, talla, tamaño), pregunta cuál
   quiere antes de cerrar. Pregunta la cantidad si no la dijo.
3) Pide los datos de entrega que usa el negocio y, al final, nombre y teléfono
   juntos. Una pregunta por mensaje.
4) Cierra con el resumen.

${
  agenda
    ? `SI EN REALIDAD QUIERE EL SERVICIO (agendar), no un producto: dile que con
gusto y agrega [califica]:true al final, en línea aparte.`
    : ''
}

${BLOQUE_CIERRE_VENTA}

${CIERRE_ASESOR}

${CIERRE_PERDIDO}

${bloqueEstilo(ficha)}

[BLOQUE_TONO_PERSONALIZADO]
[BLOQUE_INSTRUCCIONES_EXTRA]`);
}

function promptCotizacion(ficha, plan) {
  const agenda = plan.objetivos.includes('agendar');
  return dedent(`Eres [NOMBRE_ASISTENTE], de [NOMBRE_TIENDA]. Hablas con alguien que necesita una cotización o un servicio a medida.

${seccionNegocio(ficha)}

TU TRABAJO AQUÍ
Entender bien lo que necesita y dejarle la ficha lista a la persona del
equipo que cotiza. No prometas precios finales ni plazos que no estén en la
información del negocio.

${
  agenda
    ? `SI LO QUE QUIERE SE PUEDE ${plan.cita_en_cliente ? 'RESERVAR' : 'AGENDAR'} DIRECTO (está en el catálogo con precio),
no lo hagas pasar por una cotización: agrega [califica]:true al final, en
línea aparte, y la etapa siguiente lo cierra.`
    : ''
}

${BLOQUE_COTIZACION}

${CIERRE_ASESOR}

${CIERRE_PERDIDO}

${bloqueEstilo(ficha)}

[BLOQUE_TONO_PERSONALIZADO]
[BLOQUE_INSTRUCCIONES_EXTRA]`);
}

/* ──────────────────────────────────────────────────────────────
   Tablero completo.
   ────────────────────────────────────────────────────────────── */
/* Qué modelo lleva cada columna con IA.
   - Si el dueño eligió uno en el cuestionario (ficha.modelo ≠ 'auto'), ese en
     todas las etapas.
   - Si no, por tipo de etapa: uno fuerte donde el bot decide con datos y
     emite tags (entrada, agenda, venta, cotización) y uno económico donde solo
     conversa (fuera de zona, atendido). Con proveedor Claude, los equivalentes. */
function modelosPara(ficha) {
  const esClaude = String(ficha?.proveedor_ia || '') === 'claude';
  const elegido = String(ficha?.modelo || 'auto').trim();
  if (elegido && elegido !== 'auto') return { decision: elegido, simple: elegido };
  return esClaude
    ? { decision: 'claude-opus-5-5', simple: 'claude-haiku-5-5' }
    : { decision: 'gpt-4o', simple: 'gpt-4o-mini' };
}

function construirColumnas(ficha, plan) {
  const M = modelosPara(ficha);
  const tiene = (estado) => plan.columnas.some((c) => c.estado_db === estado);
  const nombreDe = (estado) =>
    plan.columnas.find((c) => c.estado_db === estado)?.nombre || estado;
  const agenda = tiene('por_agendar');
  const vende = tiene('venta_producto');
  const cotiza = tiene('cotizacion');
  const zona = tiene('fuera_zona');
  const lugarCita = plan.cita_en_cliente ? 'cliente' : 'sede';

  /* Acciones de contexto que comparten las columnas con IA: el catálogo
     siempre (es el conocimiento del negocio) y las sedes cuando hay cobertura
     o agenda (es lo que le dice al bot a qué ciudades llega). */
  const contextoComun = (orden) => {
    const out = [ctx('contexto_productos', orden)];
    if (zona || agenda) out.push(ctx('contexto_establecimientos', orden + 1));
    return out;
  };

  const columnas = [];
  let orden = 1;

  // ── Contacto inicial ──
  {
    const acciones = [];
    let o = 1;
    if (agenda) acciones.push(accion('[califica]:true', 'por_agendar', o++));
    if (vende) acciones.push(accion('[venta_producto]:true', 'venta_producto', o++));
    if (cotiza) acciones.push(accion('[cotizacion]:true', 'cotizacion', o++));
    if (zona) acciones.push(accion('[fuera_zona]:true', 'fuera_zona', o++));
    acciones.push(accion('[asesor]:true', 'asesor', o++));
    acciones.push(accion('[perdido]:true', 'perdidos', o++));
    acciones.push(...contextoComun(o));
    columnas.push(
      base(nombreDe('contacto_inicial'), 'contacto_inicial', 'azul', 'bx bx-conversation', orden++, {
        es_principal: 1,
        activa_ia: 1,
        modelo: M.decision,
        max_tokens: 600,
        instrucciones: promptContactoInicial(ficha, plan),
        acciones,
      }),
    );
  }

  // ── Fuera de cobertura ──
  if (zona) {
    const acciones = [];
    let o = 1;
    if (vende) acciones.push(accion('[venta_producto]:true', 'venta_producto', o++));
    else if (agenda) acciones.push(accion('[califica]:true', 'por_agendar', o++));
    acciones.push(accion('[asesor]:true', 'asesor', o++));
    acciones.push(accion('[perdido]:true', 'perdidos', o++));
    acciones.push(...contextoComun(o));
    columnas.push(
      base(nombreDe('fuera_zona'), 'fuera_zona', 'gris', 'bx bx-map-alt', orden++, {
        activa_ia: 1,
        modelo: M.simple,
        max_tokens: 500,
        instrucciones: promptFueraZona(ficha, plan),
        acciones,
      }),
    );
  }

  // ── Agenda ──
  if (agenda) {
    const accionesAgenda = (extra = []) => {
      const acciones = [];
      let o = 1;
      /* Las dos van con el MISMO trigger y es intencional: una crea la cita y
         la otra mueve la tarjeta. Si solo estuviera cambiar_estado, la tarjeta
         avanzaría sin que exista la cita. */
      acciones.push({
        tipo_accion: 'agendar_cita',
        config: {
          trigger: '[cita_confirmada]:true',
          lugar_cita: lugarCita,
          ...(plan.lugar_mixto ? { lugar_mixto: true } : {}),
        },
        activo: 1,
        orden: o++,
      });
      acciones.push(accion('[cita_confirmada]:true', 'cita_agendada', o++));
      for (const e of extra) acciones.push(accion(e[0], e[1], o++));
      acciones.push(accion('[asesor]:true', 'asesor', o++));
      acciones.push(ctx('contexto_calendario', o++));
      acciones.push(...contextoComun(o));
      return acciones;
    };

    columnas.push(
      base(nombreDe('por_agendar'), 'por_agendar', 'verde', 'bx bx-calendar-plus', orden++, {
        activa_ia: 1,
        modelo: M.decision,
        max_tokens: 700,
        instrucciones: promptPorAgendar(ficha, plan),
        acciones: accionesAgenda([
          ...(vende ? [['[venta_producto]:true', 'venta_producto']] : []),
          ['[perdido]:true', 'perdidos'],
        ]),
      }),
    );
    columnas.push(
      base(nombreDe('cita_agendada'), 'cita_agendada', 'cian', 'bx bx-calendar-check', orden++, {
        activa_ia: 1,
        modelo: M.decision,
        max_tokens: 600,
        instrucciones: promptCitaAgendada(ficha, plan),
        acciones: accionesAgenda([['[atendido]:true', 'atendido']]),
      }),
    );
    columnas.push(
      base(nombreDe('atendido'), 'atendido', 'lima', 'bx bx-happy-heart-eyes', orden++, {
        activa_ia: 1,
        modelo: M.simple,
        max_tokens: 500,
        instrucciones: promptAtendido(ficha, plan),
        acciones: accionesAgenda(),
      }),
    );
  }

  // ── Venta de producto ──
  if (vende) {
    const acciones = [];
    let o = 1;
    acciones.push(accion('[venta_cerrada]:true', 'venta_cerrada', o++));
    if (agenda) acciones.push(accion('[califica]:true', 'por_agendar', o++));
    acciones.push(accion('[asesor]:true', 'asesor', o++));
    acciones.push(accion('[perdido]:true', 'perdidos', o++));
    acciones.push(ctx('contexto_productos', o++));
    columnas.push(
      base(nombreDe('venta_producto'), 'venta_producto', 'naranja', 'bx bx-cart', orden++, {
        activa_ia: 1,
        modelo: M.decision,
        max_tokens: 700,
        instrucciones: promptVentaProducto(ficha, plan),
        acciones,
      }),
    );
    columnas.push(
      base(nombreDe('venta_cerrada'), 'venta_cerrada', 'ambar', 'bx bx-check-circle', orden++),
    );
  }

  // ── Cotización ──
  if (cotiza) {
    const acciones = [];
    let o = 1;
    acciones.push(accion('[cotizacion_lista]:true', 'por_cerrar', o++));
    if (agenda) acciones.push(accion('[califica]:true', 'por_agendar', o++));
    acciones.push(accion('[asesor]:true', 'asesor', o++));
    acciones.push(accion('[perdido]:true', 'perdidos', o++));
    acciones.push(ctx('contexto_productos', o++));
    columnas.push(
      base(nombreDe('cotizacion'), 'cotizacion', 'violeta', 'bx bx-file', orden++, {
        activa_ia: 1,
        modelo: M.decision,
        max_tokens: 700,
        instrucciones: promptCotizacion(ficha, plan),
        acciones,
      }),
    );
    columnas.push(
      base(nombreDe('por_cerrar'), 'por_cerrar', 'indigo', 'bx bx-briefcase', orden++),
    );
  }

  columnas.push(base(nombreDe('asesor'), 'asesor', 'rosa', 'bx bx-user-voice', orden++));
  columnas.push(base(nombreDe('perdidos'), 'perdidos', 'gris', 'bx bx-x-circle', orden++));

  return columnas;
}

/* ──────────────────────────────────────────────────────────────
   Seguimientos (remarketing). Todos por IA y dentro de las 24 horas: fuera
   de esa ventana Meta exige una plantilla aprobada y un negocio recién
   adaptado no tiene ninguna. El último paso NO mueve a perdidos: una
   persona que no contestó en 7 horas no es un no.
   ────────────────────────────────────────────────────────────── */
function construirRemarketing(ficha, plan) {
  const contexto = dedent(`CONTEXTO DEL NEGOCIO
  ${String(ficha.resumen_para_prompt || ficha.descripcion_para_prompt || '').trim()}

  REGLAS
  - Tuteo natural LATAM, cálido, sin presión ni urgencia falsa.
  - Retoma puntualmente lo que la persona dijo en la conversación (sin inventar).
  - NUNCA uses lenguaje de envíos ni de paquetería ("pedido empacado", "listo
    para salir", "tiempo de entrega", "48-72 horas", "contra entrega") salvo
    que la conversación sea sobre un producto que se envía.
  - No inventes precios, descuentos ni promociones.
  - Máximo 3 líneas. Solo devuelve el texto del mensaje, sin comillas.`);

  const paso = (minutos, estado_destino, objetivo) => ({
    tiempo_espera_minutos: minutos,
    nombre_template: '',
    language_code: 'es',
    estado_destino,
    header_format: null,
    metodo_dentro_24h: 'ia',
    prompt_ia: `${objetivo}\n\n${contexto}`,
  });

  const grupos = [];
  grupos.push({
    estado_contacto: 'contacto_inicial',
    secuencias: [
      paso(
        60,
        'contacto_inicial',
        'La persona dejó la conversación a medias, antes de que supieras qué necesita. OBJETIVO: retomar con UNA sola pregunta, la que falte para poder ayudarla.',
      ),
      paso(
        300,
        'contacto_inicial',
        'Segundo intento: la persona no ha respondido en varias horas. OBJETIVO: dejar la puerta abierta sin insistir; ofrécele responder cuando pueda.',
      ),
    ],
  });
  if (plan.columnas.some((c) => c.estado_db === 'por_agendar')) {
    grupos.push({
      estado_contacto: 'por_agendar',
      secuencias: [
        paso(
          120,
          'por_agendar',
          `La persona quería ${plan.cita_en_cliente ? 'reservar el servicio' : 'agendar'} y se quedó a mitad de camino. OBJETIVO: retomar justo donde quedó (si faltaba elegir horario, recuérdale que puedes proponerle dos opciones; si faltaba un dato, pídelo). Una sola pregunta.`,
        ),
        paso(
          420,
          'por_agendar',
          'Segundo intento, varias horas después. OBJETIVO: un mensaje corto y amable que recuerde que la reserva sigue disponible, sin presionar. Cierra con una pregunta fácil de responder.',
        ),
      ],
    });
  }
  if (plan.columnas.some((c) => c.estado_db === 'venta_producto')) {
    grupos.push({
      estado_contacto: 'venta_producto',
      secuencias: [
        paso(
          90,
          'venta_producto',
          'La persona estaba por comprar un producto y dejó de responder. OBJETIVO: retomar con el producto que le interesó y la duda o el dato que quedó pendiente. Una sola pregunta.',
        ),
        paso(
          360,
          'venta_producto',
          'Segundo intento. OBJETIVO: recordarle con calidez que el producto sigue disponible y preguntarle si quiere que le ayudes a cerrarlo, sin presionar.',
        ),
      ],
    });
  }
  if (plan.columnas.some((c) => c.estado_db === 'cotizacion')) {
    grupos.push({
      estado_contacto: 'cotizacion',
      secuencias: [
        paso(
          120,
          'cotizacion',
          'La persona pedía una cotización y dejó de responder antes de completar los datos. OBJETIVO: pedir UN solo dato que falte para poder cotizarle, explicando para qué sirve.',
        ),
        paso(
          480,
          'cotizacion',
          'Segundo intento. OBJETIVO: ofrecerle que alguien del equipo la contacte con una propuesta, sin presionar. Una pregunta de sí o no.',
        ),
      ],
    });
  }
  return grupos;
}

module.exports = {
  dedent,
  armarPlan,
  modelosPara,
  construirColumnas,
  construirRemarketing,
  BLOQUE_CITA_CLIENTE,
  BLOQUE_CITA_SEDE,
};
