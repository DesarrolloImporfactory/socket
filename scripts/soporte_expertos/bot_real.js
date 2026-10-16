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
  Un turno completo. `llamar` es el de crearLlamador; sin él se usa `doble`
  (texto o función del contexto) como respuesta del modelo.
  Devuelve { crudo, enviado, ctx, response_id, usage, guardia, modelo }:
  `modelo` es lo que escribió el modelo, `crudo` lo que deja la guardia y
  `enviado` lo que vería el cliente.
*/
async function responderTurno({
  telefono, id_cliente, mensaje, tipo = 'text', contexto_motor = null, previous_response_id = null,
  llamar = null, doble = null, consultar, buscador, hoy, id_configuracion = 265,
}) {
  const ctx = await prepararTurno({
    mensaje, telefono, tipo_mensaje: tipo, id_configuracion, id_cliente,
    deps: { consultar, hoy, buscador },
  });
  let respuesta;
  let response_id = previous_response_id;
  let usage = null;
  if (llamar) {
    const r = await llamar(entrada(ctx, { cliente: mensaje, contexto_motor }), previous_response_id);
    response_id = r.response_id || previous_response_id;
    usage = r.usage || null;
    respuesta = r.respuesta || '';
  } else {
    respuesta = typeof doble === 'function' ? doble(ctx) : doble || '';
  }
  const p = procesar(respuesta, ctx.hechos);
  return { crudo: p.crudo, enviado: p.texto, ctx, response_id, usage, guardia: p.guardia, modelo: respuesta };
}

module.exports = { procesar, entrada, crearLlamador, responderTurno };
