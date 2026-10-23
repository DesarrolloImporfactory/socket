/* "ADAPTAR EL BOT A MI NEGOCIO".

   El cliente que no es e-commerce ni calza en una plantilla global (una
   serenata a domicilio, un fotógrafo, un taller) terminaba con dos opciones
   malas: usar un tablero de otro rubro, o escribir un prompt gigante a mano
   sobre columnas que no lo entienden. Esto arma un tablero propio en tres
   pasos:

     1. CUESTIONARIO  — preguntas clave (qué vende, qué quiere que haga el
                        bot, dónde se da el servicio, cómo cobra, su tono).
     2. COMPRENDER    — la IA de la cuenta ordena esas respuestas en una FICHA
                        del negocio y la devuelve escrita en segunda persona
                        ("Entiendo que…") para que el dueño confirme o corrija
                        ANTES de construir nada. El embudo (plan) sale de la
                        ficha de forma determinista: la IA no decide columnas.
     3. CONSTRUIR     — se borra el tablero anterior y se instala el nuevo con
                        los bloques probados de kanban_bloques_servicios.

   Usa la llave de IA del cliente (OpenAI, o Claude si es su proveedor): sin
   llave no hay bot, así que tampoco hay nada que adaptar.

   Lo que se guarda (kanban_adaptaciones) son las respuestas, la ficha y el
   plan: con eso se puede volver a construir, comparar o mejorar el generador
   contra casos reales sin pedirle al cliente que lo repita. */

const axios = require('axios');
const { db } = require('../database/config');
const { leerApiKeyOpenAI } = require('../utils/openia/apiKeyOpenAI');
const { compilarPromptFinal } = require('../utils/promptCompiler');
const {
  armarPlan,
  modelosPara,
  construirColumnas,
  construirRemarketing,
} = require('../utils/kanban_bloques_servicios.data');
const { reiniciarTablero } = require('./kanban_tablero.service');

/* Modelo para ordenar la ficha. gpt-4.1 responde a cualquier organización
   (gpt-5 exige organización verificada: ver gpt5 en memoria/README) y
   soporta json_schema estricto. */
const MODELO_OPENAI = 'gpt-4.1';
const MODELO_OPENAI_RESPALDO = 'gpt-4o';

// ─────────────────────────────────────────────────────────────
// 1. CUESTIONARIO
// Lo renderiza el front tal cual: cambiar una pregunta acá no pide deploy del
// front. `clave` es la llave en `respuestas`.
// ─────────────────────────────────────────────────────────────
const OBJETIVOS = [
  {
    valor: 'agendar',
    titulo: 'Agendar citas o reservas',
    detalle: 'El bot propone horarios libres y deja la cita creada en tu agenda.',
    icono: 'bx bx-calendar-check',
  },
  {
    valor: 'vender_productos',
    titulo: 'Vender productos o paquetes',
    detalle: 'Resuelve dudas con tu catálogo y cierra el pedido con nombre, cantidad y entrega.',
    icono: 'bx bx-cart',
  },
  {
    valor: 'cotizar',
    titulo: 'Cotizar servicios de mayor valor',
    detalle: 'Levanta qué necesita, para cuándo y presupuesto, y se lo deja listo a tu equipo para cerrar.',
    icono: 'bx bx-file',
  },
  {
    valor: 'atender',
    titulo: 'Responder dudas y derivar',
    detalle: 'Atiende preguntas frecuentes con tu información y pasa a una persona cuando hace falta.',
    icono: 'bx bx-support',
  },
];

const CUESTIONARIO = [
  {
    clave: 'negocio',
    titulo: 'Tu negocio',
    subtitulo: 'Cuéntalo como se lo contarías a alguien nuevo en tu equipo.',
    preguntas: [
      {
        clave: 'nombre_negocio',
        tipo: 'texto',
        titulo: '¿Cómo se llama tu negocio?',
        placeholder: 'Ej: Clínica Dental Sonrisa',
        obligatorio: true,
      },
      {
        clave: 'que_ofreces',
        tipo: 'textarea',
        titulo: '¿Qué ofreces y a quién?',
        ayuda:
          'Qué haces, cómo funciona el servicio y a quién le sirve. Los precios, paquetes y combos no van aquí: el bot los toma de tu Catálogo.',
        placeholder:
          'Ej: Limpieza de muebles y colchones a domicilio. Vamos con nuestros equipos y productos, el servicio dura cerca de 1 hora. Atendemos de lunes a sábado…',
        obligatorio: true,
        filas: 5,
      },
      {
        clave: 'rubro',
        tipo: 'chips',
        titulo: '¿Con cuál se parece más tu negocio?',
        opciones: [
          { valor: 'servicios_domicilio', titulo: 'Servicios a domicilio', icono: 'bx bx-car' },
          { valor: 'local', titulo: 'Local o consultorio', icono: 'bx bx-store' },
          { valor: 'tienda', titulo: 'Tienda de productos', icono: 'bx bx-shopping-bag' },
          { valor: 'profesional', titulo: 'Servicios profesionales', icono: 'bx bx-briefcase' },
          { valor: 'eventos', titulo: 'Eventos y entretenimiento', icono: 'bx bx-party' },
          { valor: 'educacion', titulo: 'Educación y cursos', icono: 'bx bx-book-open' },
          { valor: 'otro', titulo: 'Otro', icono: 'bx bx-dots-horizontal-rounded' },
        ],
      },
      {
        clave: 'clientes',
        tipo: 'textarea',
        titulo: '¿Cómo te llegan los clientes y qué suelen escribir primero?',
        ayuda: 'Para que el bot sepa con qué se va a encontrar.',
        placeholder:
          'Ej: Casi todos llegan desde anuncios de Instagram y escriben "Hola, quiero información" o preguntan el precio directo…',
        filas: 3,
      },
    ],
  },
  {
    clave: 'ventas',
    titulo: 'Cómo vendes',
    subtitulo: 'Esto decide qué etapas va a tener tu tablero.',
    preguntas: [
      {
        clave: 'objetivos',
        tipo: 'multi',
        titulo: '¿Qué quieres que haga el bot?',
        ayuda: 'Puedes marcar varias.',
        opciones: OBJETIVOS,
        obligatorio: true,
      },
      {
        clave: 'lugar_servicio',
        tipo: 'multi',
        titulo: '¿Dónde se da el servicio?',
        ayuda: 'Marca las que apliquen. Muchos negocios atienden en su local y también a domicilio.',
        opciones: [
          { valor: 'local', titulo: 'En mi local', detalle: 'La persona viene a mi local o consultorio.', icono: 'bx bx-store' },
          { valor: 'cliente', titulo: 'Donde el cliente', detalle: 'Voy a su casa, oficina o evento.', icono: 'bx bx-car' },
          { valor: 'online', titulo: 'Online', detalle: 'Por videollamada o de forma digital.', icono: 'bx bx-video' },
          { valor: 'no_aplica', titulo: 'No aplica', detalle: 'Vendo productos que se envían.', icono: 'bx bx-package' },
        ],
        obligatorio: true,
      },
      {
        clave: 'cobertura_tipo',
        tipo: 'chips',
        titulo: '¿Hasta dónde llegas?',
        ayuda: 'El bot lo usa para no agendar a quien no puedes atender.',
        opciones: [
          { valor: 'zonas', titulo: 'Solo algunas ciudades o zonas', icono: 'bx bx-map-pin' },
          { valor: 'todo_pais', titulo: 'A todo el país', icono: 'bx bx-globe' },
          { valor: 'online', titulo: 'No aplica, es online', icono: 'bx bx-wifi' },
        ],
        obligatorio: true,
      },
      {
        clave: 'cobertura',
        tipo: 'texto',
        titulo: '¿Qué ciudades o zonas cubres?',
        placeholder: 'Ej: Guayaquil y Samborondón',
        obligatorio: true,
        mostrar_si: { clave: 'cobertura_tipo', valor: 'zonas' },
      },
      {
        clave: 'forma_pago',
        tipo: 'textarea',
        titulo: '¿Cómo cobras?',
        ayuda: 'Forma de pago, si pides anticipo o reserva, y cómo se paga.',
        placeholder:
          'Ej: Se paga al terminar, en efectivo o transferencia. Para reservar pedimos un anticipo del 50% que se descuenta del total…',
        filas: 3,
      },
      {
        clave: 'datos_extra',
        tipo: 'textarea',
        titulo: '¿Qué más necesitas saber de la persona para cerrar?',
        ayuda:
          'El bot ya pide nombre, teléfono, fecha/hora y lugar cuando aplica. Agrega lo que sea propio de tu negocio.',
        placeholder: 'Ej: Cuántas personas asisten. Si tiene alguna alergia. Si es la primera vez que viene.',
        filas: 3,
      },
    ],
  },
  {
    clave: 'asistente',
    titulo: 'Tu asistente',
    subtitulo: 'Cómo quieres que hable y qué debe respetar siempre.',
    preguntas: [
      {
        clave: 'nombre_asistente',
        tipo: 'texto',
        titulo: '¿Cómo se llama tu asistente?',
        placeholder: 'Ej: Valeria',
        obligatorio: true,
      },
      {
        clave: 'tono',
        tipo: 'chips',
        titulo: '¿Qué tono quieres?',
        opciones: [
          { valor: 'cercano', titulo: 'Cercano', detalle: 'Tuteo cálido, como alguien del equipo.', icono: 'bx bx-smile' },
          { valor: 'formal', titulo: 'Formal', detalle: 'De usted, cordial y claro.', icono: 'bx bx-user-pin' },
          { valor: 'otro', titulo: 'Otro', detalle: 'Descríbelo con tus palabras.', icono: 'bx bx-edit-alt' },
        ],
        obligatorio: true,
      },
      {
        clave: 'tono_otro',
        tipo: 'texto',
        titulo: 'Describe el tono que quieres',
        placeholder: 'Ej: Alegre y juvenil, con humor ligero, pero sin perder la claridad',
        obligatorio: true,
        mostrar_si: { clave: 'tono', valor: 'otro' },
      },
      {
        clave: 'reglas',
        tipo: 'textarea',
        titulo: 'Reglas que el bot debe respetar siempre',
        ayuda: 'Lo que nunca debe hacer y lo que siempre debe ofrecer.',
        placeholder:
          'Ej: Nunca dar descuentos. Si el cliente no sabe qué elegir, recomendar el plan básico. No prometer resultados. Siempre ofrecer agendar antes de despedirse.',
        filas: 4,
      },
      {
        clave: 'objeciones',
        tipo: 'textarea',
        titulo: 'Preguntas o dudas frecuentes y cómo las respondes',
        placeholder:
          'Ej: "¿Cuánto dura?" → 1 hora. "¿Atienden sábados?" → Sí, hasta las 2 pm. "¿Está caro?" → Incluye materiales y garantía de 30 días…',
        filas: 4,
      },
      {
        clave: 'cuando_humano',
        tipo: 'textarea',
        titulo: '¿Cuándo debe pasar la conversación a una persona?',
        placeholder: 'Ej: Solo si el cliente pide hablar con alguien, o si pide algo fuera de los paquetes.',
        filas: 2,
      },
    ],
  },
];

/* Modelos que se ofrecen en el cuestionario, según el proveedor de IA de la
   cuenta. Misma lista que el selector de la columna (kanban_asistente).
   'auto' = el generador elige por etapa (fuerte donde decide, económico
   donde solo conversa). */
const MODELOS_OPENAI = [
  { valor: 'auto', titulo: 'Automático', detalle: 'Recomendado: uno fuerte donde el bot decide, uno económico donde solo conversa.', icono: 'bx bxs-magic-wand' },
  { valor: 'gpt-5-mini', titulo: 'GPT-5 mini', detalle: 'Rápido y económico. El más usado en la plataforma.', icono: 'bx bx-chip' },
  { valor: 'gpt-4o', titulo: 'GPT-4o', detalle: 'Equilibrado y muy probado en ventas y agenda.', icono: 'bx bx-chip' },
  { valor: 'gpt-4.1-mini', titulo: 'GPT-4.1 mini', detalle: 'Económico, buena redacción.', icono: 'bx bx-chip' },
  { valor: 'gpt-4o-mini', titulo: 'GPT-4o mini', detalle: 'El más barato.', icono: 'bx bx-chip' },
];
const MODELOS_CLAUDE = [
  { valor: 'auto', titulo: 'Automático', detalle: 'Recomendado: Opus donde el bot decide, Haiku donde solo conversa.', icono: 'bx bxs-magic-wand' },
  { valor: 'claude-opus-5-5', titulo: 'Claude Opus 5.5', detalle: 'Máxima calidad.', icono: 'bx bx-chip' },
  { valor: 'claude-sonnet-5-5', titulo: 'Claude Sonnet 5.5', detalle: 'Equilibrado.', icono: 'bx bx-chip' },
  { valor: 'claude-haiku-5-5', titulo: 'Claude Haiku 5.5', detalle: 'Rápido y económico.', icono: 'bx bx-chip' },
];
const MODELOS_VALIDOS = new Set(
  [...MODELOS_OPENAI, ...MODELOS_CLAUDE].map((m) => m.valor),
);

/**
 * Cuestionario para una cuenta: el genérico más la pregunta del modelo con
 * las opciones del proveedor que la cuenta tiene conectado.
 */
async function cuestionarioPara(id_configuracion) {
  let proveedor = 'openai';
  try {
    if (id_configuracion) ({ proveedor_ia: proveedor } = await llavesDeCuenta(id_configuracion));
  } catch (_) {
    /* sin cuenta: cuestionario genérico con OpenAI */
  }
  const esClaude = proveedor === 'claude';
  const pasos = JSON.parse(JSON.stringify(CUESTIONARIO));
  const asistente = pasos.find((p) => p.clave === 'asistente');
  if (asistente) {
    asistente.preguntas.splice(1, 0, {
      clave: 'modelo',
      tipo: 'chips',
      titulo: '¿Con qué modelo de IA quieres que trabaje?',
      ayuda: esClaude
        ? 'Tu cuenta usa Claude. Se aplica a todas las etapas del tablero; después puedes cambiarlo por etapa.'
        : 'Tu cuenta usa OpenAI. Se aplica a todas las etapas del tablero; después puedes cambiarlo por etapa.',
      opciones: esClaude ? MODELOS_CLAUDE : MODELOS_OPENAI,
      obligatorio: true,
    });
  }
  return { pasos, proveedor_ia: proveedor };
}

// ─────────────────────────────────────────────────────────────
// 2. COMPRENDER
// ─────────────────────────────────────────────────────────────
const SCHEMA_FICHA = {
  name: 'ficha_negocio',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      nombre_negocio: { type: 'string' },
      nombre_asistente: { type: 'string' },
      rubro: {
        type: 'string',
        description: 'Etiqueta corta del rubro, ej. "limpieza de muebles a domicilio"',
      },
      resumen_entendimiento: {
        type: 'string',
        description:
          'En segunda persona, dirigido al dueño, 3 a 5 frases que empiezan con "Entiendo que". Muestra que captaste el negocio: qué vende, a quién, cómo cierra, qué lo diferencia. Sin listas.',
      },
      descripcion_para_prompt: {
        type: 'string',
        description:
          'En tercera persona, para el bot. TODO lo que el dueño dijo sobre el servicio: qué es, qué incluye, paquetes y precios si los dio, cómo funciona, duración, qué lo diferencia. Completo pero sin relleno. No inventes nada que el dueño no haya dicho.',
      },
      resumen_para_prompt: {
        type: 'string',
        description: 'Una o dos frases que resumen el negocio, para mensajes de seguimiento.',
      },
      objetivos: {
        type: 'array',
        items: { type: 'string', enum: ['agendar', 'vender_productos', 'cotizar', 'atender'] },
      },
      lugar_servicio: {
        type: 'string',
        enum: ['local', 'cliente', 'ambos', 'online', 'no_aplica'],
        description: '"ambos" cuando atiende en su local Y también a domicilio.',
      },
      cobertura: {
        type: 'object',
        additionalProperties: false,
        properties: {
          tiene: { type: 'boolean', description: 'true solo si el negocio atiende en zonas concretas' },
          texto: { type: ['string', 'null'] },
          ciudades: { type: 'array', items: { type: 'string' } },
        },
        required: ['tiene', 'texto', 'ciudades'],
      },
      forma_pago: { type: ['string', 'null'] },
      anticipo: {
        type: ['string', 'null'],
        description: 'Si pide reserva o anticipo: cuánto, cómo y si es obligatorio u opcional.',
      },
      datos_para_cerrar_otros: {
        type: 'array',
        items: { type: 'string' },
        description: 'Datos propios del negocio que el bot debe preguntar antes de cerrar, además de nombre, teléfono, fecha/hora y lugar.',
      },
      politicas: {
        type: 'array',
        items: { type: 'string' },
        description: 'Reglas de oro en imperativo, cortas, una idea por regla. Incluye lo que el dueño dijo que nunca debe hacer y lo que siempre debe ofrecer.',
      },
      objeciones: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: { pregunta: { type: 'string' }, respuesta: { type: 'string' } },
          required: ['pregunta', 'respuesta'],
        },
      },
      tono: { type: 'string', enum: ['cercano', 'formal', 'otro'] },
      tono_detalle: {
        type: ['string', 'null'],
        description:
          'Si el dueño describió el tono con sus palabras, va aquí tal cual (resumido en una frase). Si no, un matiz propio de este negocio o null.',
      },
      cuando_humano: { type: 'array', items: { type: 'string' } },
      lo_que_hara: {
        type: 'array',
        items: { type: 'string' },
        description: '3 a 5 frases concretas de lo que el bot va a hacer para ESTE negocio, en segunda persona ("Va a…").',
      },
      lo_que_no_hara: {
        type: 'array',
        items: { type: 'string' },
        description: '3 a 5 frases concretas de lo que el bot NO va a hacer (no inventar precios, no dar por reservado sin datos, etc.), adaptadas a este negocio.',
      },
      preguntas_pendientes: {
        type: 'array',
        items: { type: 'string' },
        description: 'Máximo 4. Cosas que el dueño debería aclarar o cargar para que el bot funcione mejor (ej. "no tienes servicios cargados en el catálogo", "no dijiste si cobras anticipo"). Vacío si no hay.',
      },
    },
    required: [
      'nombre_negocio',
      'nombre_asistente',
      'rubro',
      'resumen_entendimiento',
      'descripcion_para_prompt',
      'resumen_para_prompt',
      'objetivos',
      'lugar_servicio',
      'cobertura',
      'forma_pago',
      'anticipo',
      'datos_para_cerrar_otros',
      'politicas',
      'objeciones',
      'tono',
      'tono_detalle',
      'cuando_humano',
      'lo_que_hara',
      'lo_que_no_hara',
      'preguntas_pendientes',
    ],
  },
};

const INSTRUCCIONES_COMPRENDER = `Eres el consultor de implementación de ImporChat, una plataforma de ventas por WhatsApp con bots de IA. Un dueño de negocio acaba de responder un cuestionario para adaptar su bot. Tu trabajo es ordenar lo que dijo en una ficha del negocio.

REGLAS
- Trabaja SOLO con lo que el dueño escribió y con el catálogo que se te entrega. No inventes servicios, precios, políticas ni coberturas. Si algo importante falta, va en preguntas_pendientes, no lo rellenes.
- Respeta los objetivos que marcó. Puedes agregar "atender" si por lo que cuenta claramente responde dudas, pero nunca quites uno que marcó.
- lugar_servicio: usa lo que marcó; si marcó "En mi local" y también "Donde el cliente", es "ambos".
- tono: usa lo que marcó; si eligió "Otro", tono es "otro" y tono_detalle es la descripción que escribió.
- cobertura.tiene es true solo si eligió cubrir algunas ciudades o zonas y las nombró; si dijo "todo el país" u "online", es false.
- descripcion_para_prompt es lo que el bot va a saber del negocio: todos los hechos que el dueño dio (paquetes, precios, qué incluye, cuántas personas, duración, transporte, etc.), en tercera persona, ordenado, sin adjetivos de relleno. Si el catálogo trae servicios con precio, no hace falta repetir cada precio: di que las opciones y precios están en el catálogo y resume lo que los diferencia.
- politicas: convierte las reglas del dueño en frases imperativas cortas. Agrega las que se deduzcan de la forma de pago (ej. "La reserva es opcional: pídela una sola vez y no insistas").
- objeciones: cada pregunta frecuente con su respuesta tal como el dueño la respondería.
- lo_que_hara y lo_que_no_hara: concretos para este negocio, no genéricos. Sirven para que el dueño confirme que entendiste.
- resumen_entendimiento: en segunda persona, cálido y seguro, como un consultor que de verdad entendió. Empieza con "Entiendo que".
- Escribe todo en español neutro LATAM.`;

async function llavesDeCuenta(id_configuracion) {
  const [cfg] = await db.query(
    `SELECT id, nombre_configuracion, id_usuario, pais, proveedor_ia,
            api_key_openai, api_key_claude
       FROM configuraciones WHERE id = ? LIMIT 1`,
    { replacements: [id_configuracion], type: db.QueryTypes.SELECT },
  );
  if (!cfg) {
    const e = new Error(`No existe la configuración ${id_configuracion}`);
    e.statusCode = 404;
    throw e;
  }
  return {
    cfg,
    api_key_openai: leerApiKeyOpenAI(cfg.api_key_openai) || null,
    api_key_claude: cfg.api_key_claude || null,
    proveedor_ia: cfg.proveedor_ia || 'openai',
  };
}

async function catalogoResumen(id_configuracion) {
  const items = await db.query(
    `SELECT nombre, tipo, precio, duracion
       FROM productos_chat_center
      WHERE id_configuracion = ? AND eliminado = 0
      ORDER BY id ASC LIMIT 60`,
    { replacements: [id_configuracion], type: db.QueryTypes.SELECT },
  );
  return items;
}

async function sedesDe(id_configuracion) {
  return db.query(
    `SELECT id, nombre, ciudad, id_calendario
       FROM establecimientos_chat_center
      WHERE id_configuracion = ? AND eliminado = 0 AND activo = 1
      ORDER BY orden ASC, id ASC`,
    { replacements: [id_configuracion], type: db.QueryTypes.SELECT },
  );
}

function textoRespuestas(respuestas, catalogo) {
  const r = respuestas || {};
  const etiqueta = (clave, valor) => {
    for (const paso of CUESTIONARIO) {
      const p = paso.preguntas.find((q) => q.clave === clave);
      if (!p) continue;
      if (p.tipo === 'chips' || p.tipo === 'multi') {
        const vals = Array.isArray(valor) ? valor : [valor];
        return vals
          .map((v) => p.opciones.find((o) => o.valor === v)?.titulo || v)
          .filter(Boolean)
          .join(', ');
      }
    }
    return String(valor ?? '').trim();
  };

  const lineas = [];
  for (const paso of CUESTIONARIO) {
    for (const p of paso.preguntas) {
      const v = r[p.clave];
      if (v == null || v === '' || (Array.isArray(v) && !v.length)) continue;
      lineas.push(`${p.titulo}\n${etiqueta(p.clave, v)}`);
    }
  }

  if (catalogo.length) {
    lineas.push(
      `CATÁLOGO YA CARGADO EN LA CUENTA (${catalogo.length} items)\n` +
        catalogo
          .map(
            (c) =>
              `- ${c.nombre} · ${c.tipo || 'sin tipo'}${c.precio != null ? ` · $${c.precio}` : ''}${c.duracion ? ` · ${c.duracion} min` : ''}`,
          )
          .join('\n'),
    );
  } else {
    lineas.push('CATÁLOGO YA CARGADO EN LA CUENTA\n(ninguno: el dueño todavía no ha cargado servicios ni productos)');
  }
  return lineas.join('\n\n');
}

async function fichaConOpenAI({ api_key, texto }) {
  const pedir = async (model) =>
    axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model,
        messages: [
          { role: 'system', content: INSTRUCCIONES_COMPRENDER },
          { role: 'user', content: texto.slice(0, 20000) },
        ],
        response_format: { type: 'json_schema', json_schema: SCHEMA_FICHA },
        temperature: 0.3,
      },
      {
        headers: { Authorization: `Bearer ${api_key}`, 'Content-Type': 'application/json' },
        timeout: 90000,
      },
    );

  let data;
  try {
    ({ data } = await pedir(MODELO_OPENAI));
  } catch (e) {
    const status = e?.response?.status;
    const msg = e?.response?.data?.error?.message || e.message;
    // Modelo no disponible para esta organización: se intenta con el respaldo.
    if (status === 404 || status === 403 || /model/i.test(String(msg))) {
      ({ data } = await pedir(MODELO_OPENAI_RESPALDO));
    } else {
      const err = new Error(`OpenAI: ${msg}`);
      err.statusCode = status === 401 ? 400 : 502;
      throw err;
    }
  }
  const crudo = data?.choices?.[0]?.message?.content;
  if (!crudo) throw new Error('La IA no devolvió la ficha');
  return JSON.parse(crudo);
}

async function fichaConClaude({ api_key_claude, texto }) {
  const { claudeJson } = require('../utils/claude/claude');
  const r = await claudeJson({
    api_key_claude,
    system: INSTRUCCIONES_COMPRENDER,
    input: texto.slice(0, 20000),
    schema: SCHEMA_FICHA.schema,
    max_tokens: 4000,
  });
  if (!r?.json) throw new Error('La IA no devolvió la ficha');
  return r.json;
}

/* Lo que el dueño marcó manda sobre lo que el modelo "entendió": si marcó
   agendar, el tablero agenda aunque la IA lo haya dejado afuera. */
function reconciliar(ficha, respuestas) {
  const r = respuestas || {};
  const f = { ...ficha };
  const marcados = Array.isArray(r.objetivos) ? r.objetivos : [];
  const set = new Set([...(f.objetivos || []), ...marcados]);
  f.objetivos = ['agendar', 'vender_productos', 'cotizar', 'atender'].filter((o) => set.has(o));
  if (!f.objetivos.length) f.objetivos = ['atender'];
  /* Lugar: el cuestionario permite marcar varios; local + donde el cliente
     es "ambos" (el bot pregunta cuál prefiere la persona). */
  const lugares = Array.isArray(r.lugar_servicio)
    ? r.lugar_servicio
    : r.lugar_servicio
      ? [r.lugar_servicio]
      : [];
  if (lugares.length) {
    if (lugares.includes('local') && lugares.includes('cliente')) f.lugar_servicio = 'ambos';
    else if (lugares.includes('cliente')) f.lugar_servicio = 'cliente';
    else if (lugares.includes('local')) f.lugar_servicio = 'local';
    else if (lugares.includes('online')) f.lugar_servicio = 'online';
    else f.lugar_servicio = 'no_aplica';
  }
  if (r.tono) {
    f.tono = ['cercano', 'formal', 'otro'].includes(r.tono) ? r.tono : 'cercano';
    if (r.tono === 'otro' && String(r.tono_otro || '').trim()) {
      f.tono_detalle = String(r.tono_otro).trim();
    }
  }
  if (r.nombre_negocio) f.nombre_negocio = String(r.nombre_negocio).trim();
  if (r.nombre_asistente) f.nombre_asistente = String(r.nombre_asistente).trim();
  /* Modelo elegido en el cuestionario; 'auto' deja que el generador decida
     por etapa. No viene del LLM: se guarda tal cual en la ficha. */
  f.modelo = MODELOS_VALIDOS.has(String(r.modelo || '')) ? String(r.modelo) : f.modelo || 'auto';
  f.cobertura = f.cobertura || { tiene: false, texto: null, ciudades: [] };
  if (!Array.isArray(f.cobertura.ciudades)) f.cobertura.ciudades = [];
  if (r.cobertura_tipo === 'todo_pais' || r.cobertura_tipo === 'online') {
    f.cobertura = { tiene: false, texto: null, ciudades: [] };
  } else if (r.cobertura_tipo === 'zonas' && String(r.cobertura || '').trim()) {
    f.cobertura.tiene = true;
    if (!f.cobertura.texto) f.cobertura.texto = String(r.cobertura).trim();
  }
  for (const k of [
    'datos_para_cerrar_otros',
    'politicas',
    'objeciones',
    'cuando_humano',
    'lo_que_hara',
    'lo_que_no_hara',
    'preguntas_pendientes',
  ]) {
    if (!Array.isArray(f[k])) f[k] = [];
  }
  return f;
}

/**
 * Paso 2: ordena las respuestas en una ficha y arma el plan del tablero.
 */
async function comprender({ id_configuracion, respuestas }) {
  const { api_key_openai, api_key_claude, proveedor_ia } =
    await llavesDeCuenta(id_configuracion);

  if (!api_key_openai && !api_key_claude) {
    const e = new Error(
      'Conecta tu llave de OpenAI antes de adaptar el bot: es la que va a usar para atender.',
    );
    e.statusCode = 400;
    e.code = 'SIN_API_KEY';
    throw e;
  }

  const catalogo = await catalogoResumen(id_configuracion);
  const texto = textoRespuestas(respuestas, catalogo);

  /* Se intenta primero con el proveedor de la cuenta y, si esa llave falla,
     con la otra: la ficha es una llamada puntual y lo que importa es que
     salga. Una cuenta con proveedor Claude y la llave de Claude vencida, pero
     con OpenAI válida, antes se quedaba en "API key inválida". */
  const intentos = [];
  if (proveedor_ia === 'claude' && api_key_claude) {
    intentos.push(() => fichaConClaude({ api_key_claude, texto }));
    if (api_key_openai) intentos.push(() => fichaConOpenAI({ api_key: api_key_openai, texto }));
  } else {
    if (api_key_openai) intentos.push(() => fichaConOpenAI({ api_key: api_key_openai, texto }));
    if (api_key_claude) intentos.push(() => fichaConClaude({ api_key_claude, texto }));
  }
  let ficha;
  let ultimoError;
  for (const intento of intentos) {
    try {
      ficha = await intento();
      break;
    } catch (e) {
      ultimoError = e;
      console.warn('[adaptar][comprender] proveedor falló, se prueba el siguiente:', e.message);
    }
  }
  if (!ficha) {
    const e = new Error(
      `No se pudo generar la ficha con la llave de IA de la cuenta: ${ultimoError?.message || 'error desconocido'}`,
    );
    e.statusCode = ultimoError?.statusCode || 502;
    throw e;
  }

  ficha = reconciliar(ficha, respuestas);
  ficha.proveedor_ia = proveedor_ia;
  const plan = armarPlan(ficha);
  plan.modelos = modelosPara(ficha);

  if (!catalogo.length) {
    const aviso = 'Todavía no tienes servicios ni productos cargados: el bot no va a poder dar precios hasta que los cargues en Catálogo.';
    if (!ficha.preguntas_pendientes.some((p) => /cat[aá]logo/i.test(p))) {
      ficha.preguntas_pendientes.unshift(aviso);
    }
  }

  return { ficha, plan, catalogo_items: catalogo.length };
}

// ─────────────────────────────────────────────────────────────
// 3. CONSTRUIR
// ─────────────────────────────────────────────────────────────
async function asegurarTabla() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS kanban_adaptaciones (
      id INT AUTO_INCREMENT PRIMARY KEY,
      id_configuracion BIGINT NOT NULL,
      id_usuario BIGINT NULL,
      respuestas LONGTEXT NULL,
      ficha LONGTEXT NOT NULL,
      plan LONGTEXT NOT NULL,
      columnas_creadas INT NOT NULL DEFAULT 0,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_cfg (id_configuracion)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
}

const assistantIdLocal = (id_configuracion) =>
  `local_adapt_${id_configuracion}_${Date.now()}_${Math.floor(Math.random() * 1000)}`;

/* Base de operaciones. Para agendar hace falta una agenda y, para filtrar por
   ciudad, una sede con ciudad. Si el negocio no tiene ninguna se crea una con
   lo que contó; si ya tiene, no se toca nada. */
async function asegurarAgendaYSede({ id_configuracion, ficha, plan, id_usuario }) {
  const necesitaAgenda = plan.columnas.some((c) => c.estado_db === 'por_agendar');
  const necesitaSede = necesitaAgenda || plan.filtra_zona;
  const resultado = { agenda: null, sede: null };
  if (!necesitaSede) return resultado;

  const { ensureDefaultCalendar } = require('./calendars.service');
  const cal = await ensureDefaultCalendar({
    account_id: Number(id_configuracion),
    name: ficha.nombre_negocio || 'Agenda principal',
    created_by: id_usuario || null,
  });
  resultado.agenda = cal?.id || null;

  const sedes = await sedesDe(id_configuracion);
  if (sedes.length) {
    resultado.sede = { id: sedes[0].id, existente: true };
    return resultado;
  }

  const esBase = plan.cita_en_cliente;
  const primeraCiudad = String(
    (ficha.cobertura?.ciudades || [])[0] || ficha.cobertura?.texto || '',
  )
    .split(/[,;/]| y /)[0]
    .trim();
  /* Para un servicio a domicilio la "ciudad" de la base es la zona que cubre
     ("Quito y alrededores (norte, sur y valles)"): es lo que el bot lee para
     decidir cobertura, y "Quito" a secas dejaba fuera a los valles. */
  const textoCobertura = String(ficha.cobertura?.texto || '').trim();
  const ciudad =
    esBase && textoCobertura && textoCobertura.length <= 120
      ? textoCobertura
      : primeraCiudad;
  if (!ciudad) {
    // Sin ciudad no hay con qué filtrar; el contexto de sedes avisa al bot.
    return resultado;
  }
  const [idSede] = await db.query(
    `INSERT INTO establecimientos_chat_center
       (id_configuracion, nombre, ciudad, referencia, id_calendario, orden, activo, eliminado)
     VALUES (?, ?, ?, ?, ?, 0, 1, 0)`,
    {
      replacements: [
        id_configuracion,
        esBase ? `${ficha.nombre_negocio} (base)` : ficha.nombre_negocio,
        ciudad.slice(0, 120),
        esBase ? 'El servicio se realiza en la dirección del cliente.' : null,
        resultado.agenda,
      ],
      type: db.QueryTypes.INSERT,
    },
  );
  resultado.sede = { id: idSede, existente: false, ciudad };
  return resultado;
}

/**
 * Paso 3: borra el tablero actual e instala el adaptado.
 */
async function construir({
  id_configuracion,
  ficha,
  respuestas = null,
  id_usuario = null,
  /* false cuando quien llama va a sincronizar el catálogo por su cuenta y
     esperar (el script de terminal): en segundo plano el proceso se cierra
     antes de que termine. */
  sincronizar_catalogo = true,
}) {
  const { cfg, api_key_openai, api_key_claude, proveedor_ia } =
    await llavesDeCuenta(id_configuracion);
  if (!api_key_openai && !api_key_claude) {
    const e = new Error('Conecta tu llave de OpenAI antes de construir el tablero.');
    e.statusCode = 400;
    e.code = 'SIN_API_KEY';
    throw e;
  }
  if (!ficha || typeof ficha !== 'object' || !ficha.descripcion_para_prompt) {
    const e = new Error('Falta la ficha del negocio');
    e.statusCode = 400;
    throw e;
  }

  ficha = reconciliar(ficha, respuestas || {});
  /* El proveedor de la cuenta decide los modelos "auto" (OpenAI o Claude). */
  ficha.proveedor_ia = proveedor_ia;
  const plan = armarPlan(ficha);
  const columnas = construirColumnas(ficha, plan);
  const remarketing = construirRemarketing(ficha, plan);

  const personalizacion = {
    nombre_tienda: ficha.nombre_negocio || cfg.nombre_configuracion || null,
    nombre_asistente_publico: ficha.nombre_asistente || null,
  };

  const borrado = await reiniciarTablero(id_configuracion, { motivo: 'adaptar_negocio' });
  const base = await asegurarAgendaYSede({ id_configuracion, ficha, plan, id_usuario });

  const creadas = [];
  for (const col of columnas) {
    const promptCompilado = col.instrucciones
      ? compilarPromptFinal(col.instrucciones, personalizacion)
      : null;
    const assistant_id = promptCompilado ? assistantIdLocal(id_configuracion) : null;

    const [idColumna] = await db.query(
      `INSERT INTO kanban_columnas
         (id_configuracion, nombre, estado_db, color_fondo, color_texto,
          icono, orden, activo, es_estado_final, es_principal, es_dropi_principal,
          activa_ia, max_tokens, instrucciones, modelo, assistant_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      {
        replacements: [
          id_configuracion,
          col.nombre,
          col.estado_db,
          col.color_fondo,
          col.color_texto,
          col.icono,
          col.orden,
          col.activo,
          col.es_estado_final,
          col.es_principal || 0,
          col.es_dropi_principal || 0,
          col.activa_ia,
          col.max_tokens,
          promptCompilado,
          col.modelo || 'gpt-4o-mini',
          assistant_id,
        ],
        type: db.QueryTypes.INSERT,
      },
    );

    for (const a of col.acciones || []) {
      await db.query(
        `INSERT INTO kanban_acciones
           (id_kanban_columna, id_configuracion, tipo_accion, config, activo, orden)
         VALUES (?, ?, ?, ?, ?, ?)`,
        {
          replacements: [
            idColumna,
            id_configuracion,
            a.tipo_accion,
            JSON.stringify(a.config || {}),
            a.activo ?? 1,
            a.orden,
          ],
          type: db.QueryTypes.INSERT,
        },
      );
    }

    if (col.instrucciones) {
      await db.query(
        `INSERT INTO kanban_columnas_personalizaciones
           (id_kanban_columna, id_configuracion, nombre_tienda, nombre_asistente_publico, prompt_base_snapshot)
         VALUES (?, ?, ?, ?, ?)`,
        {
          replacements: [
            idColumna,
            id_configuracion,
            personalizacion.nombre_tienda,
            personalizacion.nombre_asistente_publico,
            col.instrucciones,
          ],
          type: db.QueryTypes.INSERT,
        },
      );
    }

    creadas.push({
      id: idColumna,
      nombre: col.nombre,
      estado_db: col.estado_db,
      activa_ia: col.activa_ia,
      acciones: (col.acciones || []).length,
    });
  }

  // Seguimientos: todos por IA dentro de las 24 h (sin plantilla Meta).
  let seguimientos = 0;
  for (const grupo of remarketing) {
    const secs = [...grupo.secuencias].sort(
      (a, b) => a.tiempo_espera_minutos - b.tiempo_espera_minutos,
    );
    for (let i = 0; i < secs.length; i += 1) {
      const s = secs[i];
      await db.query(
        `INSERT INTO configuracion_remarketing
           (id_configuracion, estado_contacto, secuencia,
            tiempo_espera_horas, tiempo_espera_minutos, nombre_template, language_code,
            estado_destino, header_format, header_media_url, header_media_name,
            header_parameters, id_template_rapido, usar_respuesta_rapida,
            metodo_dentro_24h, prompt_ia, activo)
         VALUES (?, ?, ?, ?, ?, '', 'es', ?, NULL, NULL, NULL, NULL, NULL, 0, 'ia', ?, 1)`,
        {
          replacements: [
            id_configuracion,
            grupo.estado_contacto,
            i + 1,
            Math.max(1, Math.round(s.tiempo_espera_minutos / 60)),
            s.tiempo_espera_minutos,
            s.estado_destino,
            s.prompt_ia,
          ],
          type: db.QueryTypes.INSERT,
        },
      );
      seguimientos += 1;
    }
  }

  /* Contactos que estaban en columnas que ya no existen (generar_guia,
     remarketing, pendiente_confirmacion…): sin esto desaparecen del tablero
     y el bot no los atiende. Los cerrados van a perdidos, los que estaban
     con una persona siguen en asesor, y el resto vuelve al inicio. */
  const estadosNuevos = new Set(columnas.map((c) => c.estado_db));
  const aPerdidos = ['cancelados', 'perdidos', 'cancelado', 'devolucion'];
  let recolocados = 0;
  try {
    const porEstado = await db.query(
      `SELECT estado_contacto, COUNT(*) n FROM clientes_chat_center
        WHERE id_configuracion = ? AND estado_contacto IS NOT NULL
        GROUP BY estado_contacto`,
      { replacements: [id_configuracion], type: db.QueryTypes.SELECT },
    );
    for (const row of porEstado) {
      const estado = String(row.estado_contacto || '');
      if (!estado || estadosNuevos.has(estado)) continue;
      const destino = aPerdidos.includes(estado)
        ? 'perdidos'
        : estado === 'asesor'
          ? 'asesor'
          : 'contacto_inicial';
      if (!estadosNuevos.has(destino)) continue;
      await db.query(
        `UPDATE clientes_chat_center SET estado_contacto = ?
          WHERE id_configuracion = ? AND estado_contacto = ?`,
        {
          replacements: [destino, id_configuracion, estado],
          type: db.QueryTypes.UPDATE,
        },
      );
      recolocados += Number(row.n) || 0;
    }
  } catch (err) {
    console.error('[adaptar] no se pudieron recolocar los contactos:', err.message);
  }

  await db.query(
    `UPDATE configuraciones
        SET tipo_configuracion = 'kanban', kanban_global_activo = 0,
            kanban_global_id = NULL, prompt_version = NULL, pais_plantilla = ?
      WHERE id = ?`,
    {
      replacements: [String(cfg.pais || 'ec').toUpperCase().slice(0, 2), id_configuracion],
      type: db.QueryTypes.UPDATE,
    },
  );

  await asegurarTabla();
  await db.query(
    `INSERT INTO kanban_adaptaciones
       (id_configuracion, id_usuario, respuestas, ficha, plan, columnas_creadas)
     VALUES (?, ?, ?, ?, ?, ?)`,
    {
      replacements: [
        id_configuracion,
        id_usuario,
        respuestas ? JSON.stringify(respuestas) : null,
        JSON.stringify(ficha),
        JSON.stringify(plan),
        creadas.length,
      ],
      type: db.QueryTypes.INSERT,
    },
  );

  /* El catálogo entra a los asistentes en segundo plano, igual que al aplicar
     una plantilla global. */
  if (sincronizar_catalogo) setImmediate(() => {
    try {
      const {
        syncCatalogoTodasColumnasConfig,
      } = require('./syncCatalogoKanbanColumna.service');
      syncCatalogoTodasColumnasConfig(id_configuracion, {
        logger: async (...args) => console.log('[adaptar][sync-catalogo]', ...args),
      }).catch((err) =>
        console.error('[adaptar][sync-catalogo] error:', err.message),
      );
    } catch (err) {
      console.error('[adaptar][sync-catalogo] no se pudo iniciar:', err.message);
    }
  });

  return {
    columnas: creadas,
    seguimientos,
    borrado,
    contactos_recolocados: recolocados,
    agenda: base.agenda,
    sede: base.sede,
    plan,
    ficha,
  };
}

// ─────────────────────────────────────────────────────────────
// Estado de la cuenta (lo que el modal muestra antes de empezar)
// ─────────────────────────────────────────────────────────────
async function estado(id_configuracion) {
  const { cfg, api_key_openai, api_key_claude, proveedor_ia } =
    await llavesDeCuenta(id_configuracion);
  const [[cols], [prods], sedes, [cal]] = await Promise.all([
    db.query(`SELECT COUNT(*) n FROM kanban_columnas WHERE id_configuracion = ?`, {
      replacements: [id_configuracion],
      type: db.QueryTypes.SELECT,
    }),
    db.query(
      `SELECT COUNT(*) n FROM productos_chat_center WHERE id_configuracion = ? AND eliminado = 0`,
      { replacements: [id_configuracion], type: db.QueryTypes.SELECT },
    ),
    sedesDe(id_configuracion),
    db.query(`SELECT id FROM calendars WHERE account_id = ? AND is_active = 1 LIMIT 1`, {
      replacements: [id_configuracion],
      type: db.QueryTypes.SELECT,
    }),
  ]);

  let ultima = null;
  try {
    const [row] = await db.query(
      `SELECT ficha, plan, created_at FROM kanban_adaptaciones
        WHERE id_configuracion = ? ORDER BY id DESC LIMIT 1`,
      { replacements: [id_configuracion], type: db.QueryTypes.SELECT },
    );
    if (row) {
      ultima = {
        created_at: row.created_at,
        ficha: JSON.parse(row.ficha),
        plan: JSON.parse(row.plan),
      };
    }
  } catch (_) {
    /* tabla todavía no creada */
  }

  return {
    nombre_configuracion: cfg.nombre_configuracion,
    tiene_api_key: Boolean(api_key_openai || (proveedor_ia === 'claude' && api_key_claude)),
    proveedor_ia,
    columnas: Number(cols?.n || 0),
    productos: Number(prods?.n || 0),
    sedes: sedes.length,
    tiene_agenda: Boolean(cal?.id),
    ultima_adaptacion: ultima,
  };
}

module.exports = {
  CUESTIONARIO,
  cuestionarioPara,
  OBJETIVOS,
  comprender,
  construir,
  estado,
  reconciliar,
};
