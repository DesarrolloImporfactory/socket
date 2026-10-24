/*
  Un turno del bot de soporte Expertos tal como lo corre kanban_ia, sin WhatsApp
  ni escrituras: arma la entrada, llama al modelo (o recibe la respuesta de un
  doble) y la pasa por sanitizador, guardia y limpieza.

  Lo usan el arnés (arnes_soporte_expertos.js) y el simulador de conversaciones
  (simular_conversaciones_expertos.js), para que los dos prueben lo mismo.

  Lo único que lee de producción es la llave de OpenAI de la cuenta 10, y solo
  si se llama a crearLlamador(). La carga del cliente sale de quien llame
  (en las pruebas, de la base de mentira).
*/
'use strict';

const { prepararTurno, revisarTurno } = require('../../src/utils/soporteExpertos/turno');
const { sanitizarRespuestaAgente } = require('../../src/utils/openia/sanitizador_agente');
const { limpiarColetillas } = require('../../src/utils/limpiarColetillas');
const { limpiarMarkdown } = require('../../src/utils/formatoWhatsapp');
const { promptSoporteExpertos } = require('../../src/utils/prompt_soporte_expertos.data');

/* El mismo recorrido que hace kanban_ia con la respuesta del modelo. */
function procesar(respuestaModelo, hechos) {
  const sanitizada = sanitizarRespuestaAgente(String(respuestaModelo || ''));
  const rev = revisarTurno(sanitizada, hechos);
  const crudo = rev.texto;
  const sinTags = crudo.replace(/\[[^\]]+\]:\s*(true|false)/gi, '').trim();
  const texto = limpiarMarkdown(limpiarColetillas(sinTags));
  return { crudo, texto, guardia: rev };
}

/* Lo que recibe el modelo: el contexto del motor y el del turno, y el mensaje. */
const entrada = (ctx, turno) => {
  const bloque = [turno.contexto_motor, ctx.bloque].filter(Boolean).join('\n\n');
  const mensaje = ctx.mensaje || turno.cliente;
  return bloque ? `🧾 Contexto adicional:\n\n${bloque}\n\n💬 MENSAJE ACTUAL DEL CLIENTE (responde a ESTO):\n${mensaje}` : mensaje;
};

/* La llave de la cuenta 10 y una función que llama al modelo como producción
   (Responses API con store y previous_response_id). */
async function crearLlamador({ modelo = 'gpt-4.1', max_tokens = 900 } = {}) {
  const { db } = require('../../src/database/config');
  const { ejecutarConResponsesAPI } = require('../../src/services/kanban_ia.service');
  const { leerApiKeyOpenAI } = require('../../src/utils/openia/apiKeyOpenAI');
  const [c10] = await db.query('SELECT api_key_openai FROM configuraciones WHERE id = 10', { type: db.QueryTypes.SELECT });
  const api_key_openai = leerApiKeyOpenAI(c10?.api_key_openai);
  if (!api_key_openai) throw new Error('cfg 10 sin api key');
  const instructions = promptSoporteExpertos();
  const llamar = async (input, prev) =>
    ejecutarConResponsesAPI({
      previous_response_id: prev, instructions, additional_instructions: null, input,
      model: modelo, max_tokens, vector_store_id: null, api_key_openai, id_configuracion: 10,
    });
  return { llamar, instructions, api_key_openai, cerrar: () => db.close() };
}

/*
  Lo mismo con Claude, solo para simular cuando no hay saldo de OpenAI: prueba el
  prompt, no el modelo de producción. No toca la base: la llave llega de afuera.
  Claude no guarda la conversación, así que cada respuesta se guarda aquí con un
  id propio y el siguiente turno la retoma, como previous_response_id.

  Con `herramientas: true` corre como la 265 con herramientas encendidas: el
  mismo bucle y las mismas herramientas que el motor (ejecutarConClaudeHerramientas
  + crearHerramientas), el prompt con la sección de herramientas, y la carga
  sale de `consultar` (la base de mentira). `cliente` permite pasar uno falso.
  Con `diagnostico: true` se suma revisar_mi_imporchat (como la bandera
  `soporte_expertos.diagnostico`): la cuenta IMPORCHAT sale de
  `consultarImporchat` y el plan de `verificarAcceso`, que llegan por turno.
*/
function crearLlamadorClaude({
  apiKey, modelo = 'claude-sonnet-5-5', max_tokens = 4000, esfuerzo = 'low', herramientas = false, diagnostico = false, cliente: inyectado = null,
} = {}) {
  if (!apiKey && !inyectado) throw new Error('falta la llave de Claude');
  let cliente = inyectado;
  if (!cliente) {
    const Anthropic = require('@anthropic-ai/sdk');
    cliente = new Anthropic({ apiKey });
  }
  const { SECCION_HERRAMIENTAS, SECCION_DIAGNOSTICO } = require('../../src/utils/prompt_soporte_expertos.data');
  const instructions =
    promptSoporteExpertos() +
    (herramientas ? `\n\n${SECCION_HERRAMIENTAS}` : '') +
    (herramientas && diagnostico ? `\n\n${SECCION_DIAGNOSTICO}` : '');
  const historias = new Map();
  let n = 0;
  const llamarSimple = async (input, prev) => {
    const messages = [...(historias.get(prev) || []), { role: 'user', content: input }];
    const r = await cliente.messages.create({
      model: modelo, max_tokens, output_config: { effort: esfuerzo },
      system: [{ type: 'text', text: instructions, cache_control: { type: 'ephemeral' } }],
      messages,
    });
    const id = `claude_${++n}`;
    historias.set(id, [...messages, { role: 'assistant', content: r.content }]);
    const u = r.usage || {};
    return {
      respuesta: r.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim(),
      response_id: id,
      usage: { input: u.input_tokens || 0, output: u.output_tokens || 0,
        cache_lee: u.cache_read_input_tokens || 0, cache_escribe: u.cache_creation_input_tokens || 0 },
    };
  };
  // Con herramientas, la memoria guarda solo el texto de cada turno (como el
  // motor, que tampoco guarda las vueltas de herramientas entre mensajes).
  const llamarConHerramientas = async (input, prev, turno = {}) => {
    const { ejecutarConClaudeHerramientas } = require('../../src/utils/claude/herramientas');
    const { crearHerramientas } = require('../../src/utils/soporteExpertos/herramientas');
    const previos = historias.get(prev) || [];
    const h = crearHerramientas({
      telefono: turno.telefono, mensaje: turno.mensaje, canalVerificable: true, diagnostico,
      deps: {
        consultar: turno.consultar, hoy: turno.hoy,
        consultarImporchat: turno.consultarImporchat, verificarAcceso: turno.verificarAcceso, ahora: turno.ahora,
      },
    });
    const r = await ejecutarConClaudeHerramientas({
      instructions, input, model: modelo, max_tokens, herramientas: h.lista,
      mensajesPrevios: previos, deps: { client: cliente },
    });
    const id = `claude_${++n}`;
    historias.set(id, [...previos, { role: 'user', content: input }, { role: 'assistant', content: r.respuesta || '…' }]);
    return {
      respuesta: r.respuesta, response_id: id,
      usage: { input: r.usage.input - r.usage.cached - r.cacheEscrito, output: r.usage.output, cache_lee: r.usage.cached, cache_escribe: r.cacheEscrito },
      hechosHerramientas: r.hechosHerramientas, cargaConsultada: h.cargaConsultada(),
      diagnosticoConsultado: h.diagnosticoConsultado(), llamadas: r.llamadas,
    };
  };
  return { llamar: herramientas ? llamarConHerramientas : llamarSimple, instructions, cliente, cerrar: async () => {} };
}

/*
  Un turno completo. `llamar` es el de crearLlamador; sin él se usa `doble`
  (texto o función del contexto) como respuesta del modelo.
  Devuelve { crudo, enviado, ctx, response_id, usage, guardia, modelo, llamadas }:
  `modelo` es lo que escribió el modelo, `crudo` lo que deja la guardia y
  `enviado` lo que vería el cliente.
*/
async function responderTurno({
  telefono, id_cliente, mensaje, tipo = 'text', contexto_motor = null, previous_response_id = null,
  llamar = null, doble = null, consultar, buscador, hoy, id_configuracion = 265,
  consultarImporchat, verificarAcceso, ahora,
}) {
  const ctx = await prepararTurno({
    mensaje, telefono, tipo_mensaje: tipo, id_configuracion, id_cliente,
    deps: { consultar, hoy, buscador },
  });
  let respuesta;
  let response_id = previous_response_id;
  let usage = null;
  let llamadas = 0;
  if (llamar) {
    const r = await llamar(entrada(ctx, { cliente: mensaje, contexto_motor }), previous_response_id, {
      telefono, mensaje, consultar, hoy, consultarImporchat, verificarAcceso, ahora,
    });
    response_id = r.response_id || previous_response_id;
    if (r.hechosHerramientas?.length) {
      const { sumarHechosHerramientas } = require('../../src/utils/soporteExpertos/herramientas');
      sumarHechosHerramientas(ctx.hechos, r.hechosHerramientas, r.cargaConsultada, {
        mensaje, respuesta: r.respuesta, diagnostico: r.diagnosticoConsultado,
      });
    }
    llamadas = r.llamadas || 1;
    usage = r.usage || null;
    respuesta = r.respuesta || '';
  } else {
    respuesta = typeof doble === 'function' ? doble(ctx) : doble || '';
  }
  const p = procesar(respuesta, ctx.hechos);
  return { crudo: p.crudo, enviado: p.texto, ctx, response_id, usage, guardia: p.guardia, modelo: respuesta, llamadas };
}

module.exports = { procesar, entrada, crearLlamador, crearLlamadorClaude, responderTurno };
