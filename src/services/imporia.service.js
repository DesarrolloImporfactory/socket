// ═══════════════════════════════════════════════════════════════
// imporia.service.js
//
// El motor de ImporIA por la Responses API.
//
// QUÉ REEMPLAZA
//
// ImporIA quedó fuera de la migración de agosto y siguió corriendo contra
// threads/runs dentro de openai_assistants.controller.js → enviar_mensaje_gpt.
// El 2026-08-26 OpenAI apagó la Assistants API y desde ese día no contestó
// nada: 69 mensajes de usuarios y cero respuestas, con los dos assistants
// (asst_UVA… EC, asst_shn… MX) devolviendo 404.
//
// QUÉ CAMBIA RESPECTO DEL SISTEMA VIEJO
//
//   prompt    Antes vivía dentro del assistant en OpenAI. Ahora sale de
//             `imporia_prompts.instrucciones` (imporia_responses_migration.sql).
//   contexto  Antes se encadenaba por thread. Ahora por previous_response_id,
//             guardado en `threads_imporsuit.response_id`.
//   archivos  Los vector stores NO murieron con la Assistants API: viven en su
//             propio endpoint y Responses los consume igual con file_search.
//             Se reusan tal cual — el de MX es el mismo de siempre.
//   modelo    Antes era del assistant; ahora es `imporia_prompts.modelo`.
//
// POR QUÉ NO IMPORTA kanban_ia.service.js
//
// Ahí está `ejecutarConResponsesAPI`, que hace casi esto mismo, pero requerirlo
// arrastra el árbol entero de ChatCenter (webhooks, Dropi, sockets) dentro de
// un flujo que no tiene nada que ver, y ya hay avisos de requires circulares
// por eso en cron/rescatarTurnosPerdidos.js. Son ~60 líneas: se duplican.
// ═══════════════════════════════════════════════════════════════

const axios = require('axios');
const { db_2 } = require('../database/config');
const { QueryTypes } = require('sequelize');

// A los 14 días se corta la cadena y se arranca de nuevo (con recap). No es un
// número estético: OpenAI retiene las respuestas alrededor de 30 días, así que
// un previous_response_id viejo devuelve 404 y tumbaría la conversación. 14
// deja margen de sobra y es el mismo corte que usa ChatCenter en
// obtener_response.service.js.
const DIAS_VIGENCIA_CADENA = 14;

// Cuántos mensajes del historial se le recuerdan al modelo cuando no hay
// cadena. El promedio de ImporIA es ~2,5 mensajes por conversación, así que 20
// cubre de sobra hasta las más largas.
const MAX_MENSAJES_RECAP = 20;

const PAISES_VALIDOS = ['EC', 'MX'];

function log(msg) {
  console.log(`[imporia] ${msg}`);
}

// ─────────────────────────────────────────────────────────────
// Prompt del país
// ─────────────────────────────────────────────────────────────
async function cargarPrompt(pais) {
  let row;
  try {
    [row] = await db_2.query(
      `SELECT pais, instrucciones, modelo, max_tokens, vector_store_id
         FROM imporia_prompts
        WHERE pais = ? AND activo = 1
        LIMIT 1`,
      { replacements: [pais], type: QueryTypes.SELECT },
    );
  } catch (err) {
    /* El error crudo de MySQL ("Table … doesn't exist") no le dice a nadie qué
       hacer. Es el fallo más probable del despliegue, porque la migración se
       aplica a mano y es fácil desplegar el código antes. */
    if (/doesn't exist|no such table/i.test(err.message)) {
      throw new Error(
        'Falta la tabla imporia_prompts: aplica imporia_responses_migration.sql ' +
          'sobre la BD de imporsuit.',
      );
    }
    throw err;
  }

  if (!row) {
    throw new Error(
      `No hay prompt configurado para ${pais} en imporia_prompts. ` +
        `¿Se aplicó imporia_responses_migration.sql?`,
    );
  }

  /* La migración siembra los prompts con un marcador porque el texto original
     se perdió con los assistants (404) y hay que pegarlo a mano. Si llega acá
     sin reemplazar, es mejor fallar fuerte que ponerle a un cliente un
     asistente cuyo prompt literal dice "PEGAR_PROMPT_EC". */
  if (/^PEGAR_PROMPT_/.test(row.instrucciones.trim())) {
    throw new Error(
      `El prompt de ${pais} sigue siendo el marcador de la migración. ` +
        `Pega el texto real en imporia_prompts.instrucciones.`,
    );
  }

  return row;
}

// ─────────────────────────────────────────────────────────────
// Conversación de la plataforma (get-or-create)
//
// Es UNA por id_plataforma: así funcionó siempre ImporIA, sin "nueva
// conversación" ni borrado.
// ─────────────────────────────────────────────────────────────
async function obtenerConversacion(id_plataforma) {
  const [existente] = await db_2.query(
    `SELECT id, response_id, response_at
       FROM threads_imporsuit
      WHERE id_plataforma = ?
      LIMIT 1`,
    { replacements: [id_plataforma], type: QueryTypes.SELECT },
  );

  if (existente) return existente;

  /* id_thread_chat era el thread de OpenAI y hoy no se usa, pero la columna
     sigue ahí (y con 1.065 filas viejas que la tienen llena). Se le pone un
     marcador local en vez de dejarla vacía: misma convención que las columnas
     kanban nuevas del ChatCenter, que nacen con `local_…` para que se vea de
     un golpe que no corresponde a ningún objeto en OpenAI. */
  const marcador = `local_${id_plataforma}_${Date.now()}`;

  await db_2.query(
    `INSERT INTO threads_imporsuit
       (id_plataforma, id_thread_chat, nombre_chat, fecha_creacion_chat)
     VALUES (?, ?, 'Bot Imporsuit', NOW())`,
    { replacements: [id_plataforma, marcador], type: QueryTypes.INSERT },
  );

  const [creada] = await db_2.query(
    `SELECT id, response_id, response_at
       FROM threads_imporsuit
      WHERE id_plataforma = ?
      ORDER BY id DESC
      LIMIT 1`,
    { replacements: [id_plataforma], type: QueryTypes.SELECT },
  );

  if (!creada) {
    throw new Error('No se pudo crear la conversación de ImporIA');
  }

  log(`conversación nueva id=${creada.id} plataforma=${id_plataforma}`);
  return creada;
}

/**
 * La cadena sirve solo si es reciente. Devuelve el response_id vigente o null.
 */
function cadenaVigente(conversacion) {
  if (!conversacion.response_id) return null;
  if (!conversacion.response_at) return conversacion.response_id;

  const dias =
    (Date.now() - new Date(conversacion.response_at).getTime()) / 86400000;

  if (dias >= DIAS_VIGENCIA_CADENA) {
    log(
      `cadena de ${Math.floor(dias)} días descartada (conversación ${conversacion.id})`,
    );
    return null;
  }
  return conversacion.response_id;
}

// ─────────────────────────────────────────────────────────────
// Recap del historial
//
// Cuando no hay cadena, el modelo arranca ciego: no sabe que ya habló con esta
// persona y la vuelve a saludar. Pasa en dos casos y los dos importan acá:
//
//   1. La migración. Las 1.065 conversaciones tenían su historial en threads de
//      OpenAI que ya no existen; la cadena nueva empieza vacía.
//   2. Los 14 días de corte.
//
// La cura es la misma: rearmar la conversación desde mensajes_gpt_imporsuit,
// que es donde de verdad vive el historial —el thread de OpenAI era una copia—.
// Se paga una sola vez: la respuesta se guarda (store: true) y a partir del
// mensaje siguiente el contexto viaja por previous_response_id.
// ─────────────────────────────────────────────────────────────
async function construirRecap(id_thread) {
  const filas = await db_2.query(
    `SELECT rol_mensaje, texto_mensaje
       FROM mensajes_gpt_imporsuit
      WHERE id_thread = ?
        AND texto_mensaje IS NOT NULL
        AND texto_mensaje <> ''
      ORDER BY id DESC
      LIMIT ${MAX_MENSAJES_RECAP}`,
    { replacements: [id_thread], type: QueryTypes.SELECT },
  );

  if (!filas.length) return '';

  // rol_mensaje: 1 = lo escribió el usuario, 0 = lo respondió el asistente.
  // Es al revés que en ChatCenter (mensajes_clientes), así que ojo al copiar.
  return filas
    .reverse()
    .map(
      (m) =>
        `${Number(m.rol_mensaje) === 1 ? 'Usuario' : 'Asistente'}: ${String(
          m.texto_mensaje,
        ).trim()}`,
    )
    .join('\n');
}

// ─────────────────────────────────────────────────────────────
// Limpieza del texto
//
// Con file_search el modelo mete marcas de cita —【4:0†archivo.pdf】— que al
// usuario no le dicen nada. El sistema viejo no las limpiaba porque el
// assistant devolvía `annotations` aparte; acá se quitan por patrón, igual que
// hace kanban_ia.service.js.
// ─────────────────────────────────────────────────────────────
function limpiarTexto(texto) {
  return String(texto || '')
    .replace(/【[^】]*】/g, '')
    .replace(/\[\d+:\d+†[^\]]*\]/g, '')
    .replace(/\[source\]/gi, '')
    .replace(/\[doc\d+\]/gi, '')
    .replace(/[ \t]+([.,;:!?])/g, '$1')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]+$/gm, '')
    .trim();
}

function leerSalida(data) {
  const items = data?.output || [];
  const msg = items.find((item) => item.type === 'message');
  const contenido = msg?.content?.find((x) => x.type === 'output_text');
  return contenido?.text || '';
}

/** Un previous_response_id caducado o de otra cuenta: hay que reintentar sin él. */
function esCadenaInvalida(err) {
  const status = err?.response?.status;
  const msg = String(err?.response?.data?.error?.message || '').toLowerCase();
  return (
    (status === 404 || status === 400) &&
    (msg.includes('previous_response') || msg.includes('previous response'))
  );
}

// ─────────────────────────────────────────────────────────────
// La llamada
// ─────────────────────────────────────────────────────────────
async function ejecutarResponses({
  apiKey,
  prompt,
  input,
  previous_response_id,
}) {
  const headers = {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  };

  const body = {
    model: prompt.modelo || 'gpt-4.1-mini',
    instructions: prompt.instrucciones,
    input,
    store: true,
    max_output_tokens: prompt.max_tokens || 800,
  };

  if (previous_response_id) {
    body.previous_response_id = previous_response_id;
  }

  // Los archivos del asistente, reusados tal cual desde el sistema viejo.
  if (prompt.vector_store_id) {
    body.tools = [
      { type: 'file_search', vector_store_ids: [prompt.vector_store_id] },
    ];
  }

  /* gpt-5* razona antes de escribir y esos tokens descuentan del tope, así que
     con un max_output_tokens chico la respuesta puede volver VACÍA con
     status "incomplete". Mismo tratamiento que en ChatCenter: poco
     razonamiento, piso más alto, y un reintento si aun así vuelve vacía. */
  const esGpt5 = /^gpt-5/i.test(body.model);
  if (esGpt5) {
    body.reasoning = { effort: 'low' };
    body.max_output_tokens = Math.max(Number(body.max_output_tokens) || 0, 2000);
  }

  let res;
  try {
    res = await axios.post('https://api.openai.com/v1/responses', body, {
      headers,
      timeout: 120000,
    });
  } catch (err) {
    if (!previous_response_id || !esCadenaInvalida(err)) throw err;

    /* La cadena caducó antes de los 14 días (OpenAI la retiene ~30, pero puede
       desaparecer antes). Sin esto la conversación queda muerta para siempre:
       cada intento reusaría el mismo id roto. Se reintenta desde cero — el
       llamador ya trae el recap dentro de `input` solo cuando NO había cadena,
       así que acá se pierde contexto, pero se responde. */
    log('previous_response_id inválido: se reintenta sin cadena');
    delete body.previous_response_id;
    res = await axios.post('https://api.openai.com/v1/responses', body, {
      headers,
      timeout: 120000,
    });
  }

  let texto = leerSalida(res.data);

  if (esGpt5 && !texto.trim() && res.data?.status === 'incomplete') {
    const reintento = {
      ...body,
      reasoning: { effort: 'minimal' },
      max_output_tokens: Math.min(body.max_output_tokens * 2, 8000),
    };
    res = await axios.post('https://api.openai.com/v1/responses', reintento, {
      headers,
      timeout: 120000,
    });
    texto = leerSalida(res.data);
  }

  return {
    texto: limpiarTexto(texto),
    response_id: res.data?.id || null,
    total_tokens: res.data?.usage?.total_tokens || 0,
  };
}

// ─────────────────────────────────────────────────────────────
// API pública
// ─────────────────────────────────────────────────────────────
/**
 * Responde un mensaje de ImporIA y persiste los dos lados de la conversación.
 *
 * @param {number} id_plataforma  plataforma del usuario (una conversación c/u)
 * @param {string} mensaje        texto del usuario
 * @param {string} pais           'EC' | 'MX'
 * @returns {Promise<{respuesta: string, id_thread: number, total_tokens: number}>}
 */
async function responderImporia({ id_plataforma, mensaje, pais = 'EC' }) {
  const plataforma = Number(id_plataforma);
  if (!plataforma || plataforma <= 0) {
    throw new Error('id_plataforma inválido');
  }

  const texto = String(mensaje || '').trim();
  if (!texto) throw new Error('El mensaje viene vacío');

  const paisFinal = PAISES_VALIDOS.includes(String(pais).toUpperCase())
    ? String(pais).toUpperCase()
    : 'EC';

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('Falta OPENAI_API_KEY');

  const prompt = await cargarPrompt(paisFinal);
  const conversacion = await obtenerConversacion(plataforma);
  const previous_response_id = cadenaVigente(conversacion);

  /* El recap se arma ANTES de insertar el mensaje nuevo: si no, el historial
     incluiría el mensaje que además va en `input` y el modelo lo vería dos
     veces. */
  let input = texto;
  if (!previous_response_id) {
    const recap = await construirRecap(conversacion.id);
    if (recap) {
      input =
        `[CONTEXTO DE LA CONVERSACIÓN PREVIA — retómala, NO saludes de nuevo ` +
        `ni pidas datos ya dados]\n${recap}\n\n[MENSAJE ACTUAL]\n${texto}`;
      log(
        `sin cadena: sembrado con recap (${recap.length} chars) conversación=${conversacion.id}`,
      );
    }
  }

  // El mensaje del usuario se guarda pase lo que pase después: lo escribió, y
  // el historial es lo único que sobrevive a los cambios de API.
  await db_2.query(
    `INSERT INTO mensajes_gpt_imporsuit
       (id_thread, texto_mensaje, rol_mensaje, fecha_creacion)
     VALUES (?, ?, 1, NOW())`,
    { replacements: [conversacion.id, texto], type: QueryTypes.INSERT },
  );

  const resultado = await ejecutarResponses({
    apiKey,
    prompt,
    input,
    previous_response_id,
  });

  if (!resultado.texto) {
    throw new Error('OpenAI devolvió una respuesta vacía');
  }

  await db_2.query(
    `INSERT INTO mensajes_gpt_imporsuit
       (id_thread, texto_mensaje, rol_mensaje, fecha_creacion)
     VALUES (?, ?, 0, NOW())`,
    {
      replacements: [conversacion.id, resultado.texto],
      type: QueryTypes.INSERT,
    },
  );

  if (resultado.response_id) {
    await db_2.query(
      `UPDATE threads_imporsuit
          SET response_id = ?, response_at = NOW()
        WHERE id = ?`,
      {
        replacements: [resultado.response_id, conversacion.id],
        type: QueryTypes.UPDATE,
      },
    );
  }

  log(
    `respondido plataforma=${plataforma} pais=${paisFinal} ` +
      `tokens=${resultado.total_tokens} conversación=${conversacion.id}`,
  );

  return {
    respuesta: resultado.texto,
    id_thread: conversacion.id,
    total_tokens: resultado.total_tokens,
  };
}

module.exports = {
  responderImporia,
  // Exportadas para el script de verificación y para tests futuros.
  construirRecap,
  cargarPrompt,
  limpiarTexto,
};
