/* Pruebas del bot de soporte de Expertos con herramientas (tramo 1):
   el bucle de Claude con herramientas, las herramientas «ver_mi_carga» y
   «pasar_a_humano», la bandera de la cuenta y la guardia con lo que trajeron.

   Sin base de datos, sin red y sin la API de Claude: el cliente de Claude es
   un guion falso y la carga sale de la base de mentira.

     node scripts/probar_soporte_expertos_herramientas.js
*/
'use strict';

const path = require('path');

const rutaDb = require.resolve(path.join(__dirname, '../src/database/config'));
require.cache[rutaDb] = { id: rutaDb, filename: rutaDb, loaded: true, exports: { db: {}, db_2: {} } };

// Estas pruebas nunca crean un cliente real de Claude (usan uno falso), así
// que si el SDK no está instalado en esta máquina se pone uno vacío.
try {
  require.resolve('@anthropic-ai/sdk');
} catch {
  const Module = require('module');
  const resolver = Module._resolveFilename;
  Module._resolveFilename = function (pedido, ...resto) {
    return pedido === '@anthropic-ai/sdk' ? 'sdk-falso-de-anthropic' : resolver.call(this, pedido, ...resto);
  };
  require.cache['sdk-falso-de-anthropic'] = { id: 'sdk-falso-de-anthropic', loaded: true, exports: function SinSdk() { throw new Error('sin SDK en esta máquina'); } };
}

const { ejecutarConClaudeHerramientas } = require('../src/utils/claude/herramientas');
const { crearHerramientas, sumarHechosHerramientas, NO_VERIFICABLE } = require('../src/utils/soporteExpertos/herramientas');
const { prepararTurno, revisarTurno, olvidarTodo } = require('../src/utils/soporteExpertos/turno');
const { cargasDelTelefono, textoParaCliente } = require('../src/utils/soporteExpertos/cargaCliente');
const { buscadorDeArchivo } = require('../src/utils/soporteExpertos/fichas');
const ajustes = require('../src/utils/ajustesIA');
const T = require('../src/utils/soporteExpertos/textos');
const { SECCION_HERRAMIENTAS } = require('../src/utils/prompt_soporte_expertos.data');
const { baseDeMentira, TEL, HOY } = require('./soporte_expertos/base_de_mentira');

let ok = 0;
let fallos = 0;
function prueba(nombre, pasa, detalle = '') {
  if (pasa) {
    ok++;
    console.log(`  OK    ${nombre}`);
  } else {
    fallos++;
    console.log(`  FALLA ${nombre}${detalle ? ` — ${detalle}` : ''}`);
  }
}

/** Cliente de Claude falso: devuelve las respuestas del guion en orden y guarda lo que recibió. */
function clienteFalso(guion) {
  const pedidos = [];
  return {
    pedidos,
    beta: {
      messages: {
        create: async (req) => {
          pedidos.push(JSON.parse(JSON.stringify(req)));
          const r = guion[pedidos.length - 1];
          if (!r) throw new Error('el guion se acabó');
          return { id: `msg_${pedidos.length}`, model: 'claude-opus-5-5', usage: { input_tokens: 100, output_tokens: 10 }, ...r };
        },
      },
    },
  };
}
const texto = (t) => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: t }] });
const pide = (...usos) => ({
  stop_reason: 'tool_use',
  content: [{ type: 'thinking', thinking: 'pienso', signature: 'firma' }, ...usos.map(([name, input], i) => ({ type: 'tool_use', id: `tu_${i}_${name}`, name, input }))],
});
const herramienta = (name, ejecutar) => ({ definicion: { name, description: name, input_schema: { type: 'object', properties: {} } }, ejecutar });
const correr = (client, herramientas, extra = {}) =>
  ejecutarConClaudeHerramientas({ instructions: 'sistema', input: 'hola', model: 'gpt-4.1', max_tokens: 500, herramientas, deps: { client, ...(extra.deps || {}) }, ...extra });

(async () => {
  /* ───────────────────────────────────────────────────────────────────── */
  console.log('\n1. La bandera de la cuenta');
  const n = ajustes.normalizar;
  prueba('`true` NO enciende las herramientas', n({ soporte_expertos: true }).soporte_expertos.herramientas === false);
  prueba('un objeto sin la clave las deja apagadas', n({ soporte_expertos: { cargas: true } }).soporte_expertos.herramientas === false);
  prueba('solo `herramientas: true` las enciende', n({ soporte_expertos: { herramientas: true } }).soporte_expertos.herramientas === true);
  prueba('un valor raro no las enciende', n({ soporte_expertos: { herramientas: 'si' } }).soporte_expertos.herramientas === false);

  /* ───────────────────────────────────────────────────────────────────── */
  console.log('\n2. El bucle de herramientas');
  {
    const c = clienteFalso([pide(['dato', {}]), texto('Listo: 42')]);
    const r = await correr(c, [herramienta('dato', async () => 'el dato es 42')]);
    prueba('pide una herramienta y contesta con lo que trajo', r.respuesta === 'Listo: 42' && r.llamadas === 2);
    prueba('lo que trajo queda como respaldo para la guardia', r.hechosHerramientas.length === 1 && r.hechosHerramientas[0] === 'el dato es 42');
    const seg = c.pedidos[1].messages;
    prueba('el turno del modelo se reenvía con su pensamiento', seg[1].role === 'assistant' && seg[1].content[0].type === 'thinking');
    prueba('el resultado va con el id de la herramienta', seg[2].content[0].type === 'tool_result' && seg[2].content[0].tool_use_id === 'tu_0_dato' && seg[2].content[0].is_error === false);
    prueba('los tokens de las dos llamadas se suman', r.usage.input === 200 && r.usage.output === 20 && r.total_tokens === 220);
    prueba('las herramientas viajan en cada llamada', c.pedidos.every((p) => p.tools?.length === 1));
    prueba('piso de max_tokens y modelo Claude por defecto', c.pedidos[0].max_tokens === 4000 && c.pedidos[0].model === 'claude-opus-5-5');
  }
  {
    const c = clienteFalso([pide(['a', {}], ['b', {}]), texto('ok')]);
    const r = await correr(c, [herramienta('a', async () => 'A'), herramienta('b', async () => 'B')]);
    prueba('dos herramientas en la misma vuelta: dos resultados', c.pedidos[1].messages[2].content.length === 2 && r.hechosHerramientas.join() === 'A,B');
  }
  {
    const c = clienteFalso([pide(['a', {}]), pide(['a', {}]), texto('al fin')]);
    const r = await correr(c, [herramienta('a', async () => 'A')]);
    prueba('en la 3.ª llamada se prohíben más herramientas', c.pedidos[2].tool_choice?.type === 'none' && !c.pedidos[0].tool_choice && !c.pedidos[1].tool_choice);
    prueba('…y la respuesta llega', r.respuesta === 'al fin' && r.llamadas === 3);
  }
  {
    const c = clienteFalso([pide(['rota', {}]), texto('no pude')]);
    const r = await correr(c, [herramienta('rota', async () => { throw new Error('se cayó'); })]);
    const res = c.pedidos[1].messages[2].content[0];
    prueba('una herramienta que falla va como error y el bucle sigue', res.is_error === true && /No se pudo consultar/.test(res.content) && r.respuesta === 'no pude');
    prueba('…y lo que falló no cuenta como respaldo', r.hechosHerramientas.length === 0);
  }
  {
    const c = clienteFalso([pide(['inventada', {}]), texto('ok')]);
    await correr(c, [herramienta('a', async () => 'A')]);
    prueba('una herramienta que no existe va como error', c.pedidos[1].messages[2].content[0].is_error === true);
  }
  {
    const c = clienteFalso([{ ...pide(['a', {}]), content: [...pide(['a', {}]).content, { type: 'fallback', from: { model: 'x' }, to: { model: 'y' } }] }, texto('ok')]);
    await correr(c, [herramienta('a', async () => 'A')]);
    prueba('el bloque `fallback` del servidor no se reenvía', !c.pedidos[1].messages[1].content.some((b) => b.type === 'fallback'));
  }
  {
    const c = clienteFalso([{ stop_reason: 'max_tokens', content: [{ type: 'text', text: 'parcial' }] }]);
    const r = await correr(c, [herramienta('a', async () => 'A')]);
    prueba('si se corta por max_tokens devuelve el texto que haya', r.respuesta === 'parcial');
  }
  {
    const c = clienteFalso([{ stop_reason: 'refusal', content: [] }]);
    const r = await correr(c, [herramienta('a', async () => 'A')]);
    prueba('un rechazo devuelve vacío (el motor no manda nada)', r.respuesta === '');
  }
  {
    const lenta = { beta: { messages: { create: () => new Promise((res) => setTimeout(() => res(texto('tarde')), 300)) } } };
    const r = await correr(lenta, [], { deps: { client: lenta, topeTurnoMs: 50 } });
    prueba('si el turno entero se pasa del tope, sale vacío', r.respuesta === '' && r.llamadas === 0);
  }
  {
    // Revisión 3: pasado el tope, el bucle no sigue llamando ni escribiendo en el log.
    const pedidos = [];
    const lineas = [];
    const lento = { beta: { messages: { create: (req) => { pedidos.push(req); return new Promise((res) => setTimeout(() => res(pide(['a', {}])), 60)); } } } };
    const r = await correr(lento, [herramienta('a', async () => 'A')], { deps: { client: lento, topeTurnoMs: 90 }, log: (t) => lineas.push(t) });
    await new Promise((res) => setTimeout(res, 400));
    prueba('🔒 después del tope no hay más llamadas pagadas', r.respuesta === '' && pedidos.length === 2, `llamadas: ${pedidos.length}`);
    prueba('…ni líneas nuevas en el log tras el «sin respuesta»', /sin respuesta/.test(lineas[lineas.length - 1] || ''), lineas.slice(-2).join(' | '));
  }
  {
    const c = clienteFalso([texto('directo')]);
    const r = await correr(c, [herramienta('a', async () => 'A')], { mensajesPrevios: [{ role: 'user', content: 'antes' }, { role: 'assistant', content: 'dije' }] });
    prueba('sin herramienta: una sola llamada', r.respuesta === 'directo' && r.llamadas === 1);
    prueba('los mensajes previos (simulador) van antes del actual', c.pedidos[0].messages.length === 3 && c.pedidos[0].messages[2].content === 'hola');
  }

  /* ───────────────────────────────────────────────────────────────────── */
  console.log('\n3. Las herramientas de la 265');
  {
    const base = baseDeMentira();
    const h = crearHerramientas({ telefono: TEL.transito_con_fecha, mensaje: 'y lo mío?', canalVerificable: true, deps: { consultar: base.consultar, hoy: HOY } });
    const nombres = h.lista.map((x) => x.definicion.name);
    prueba('son ver_mi_carga y pasar_a_humano', nombres.join() === 'ver_mi_carga,pasar_a_humano');
    const esq = JSON.stringify(h.lista.map((x) => x.definicion.input_schema));
    prueba('🔒 ningún esquema pide teléfono, correo ni id', !/telefono|phone|correo|email|id_users|numero/i.test(esq));
    const verCarga = h.lista[0];
    const r = await verCarga.ejecutar({ telefono: TEL.dos_cargas });
    prueba('🔒 un «telefono» en lo que pide el modelo se ignora: consulta el del remitente', /📦 CARGA DE ESTE CLIENTE/.test(r) && h.cargaConsultada()?.estado === 'encontradas' && /EC-PRUEBA-OCT-A/.test(r));
    const directa = await cargasDelTelefono(TEL.transito_con_fecha, { consultar: baseDeMentira().consultar, hoy: HOY });
    prueba('…y trae lo mismo que la consulta de siempre', JSON.stringify(h.cargaConsultada().cargas) === JSON.stringify(directa.cargas));
  }
  {
    const base = baseDeMentira();
    const h = crearHerramientas({ telefono: TEL.transito_con_fecha, canalVerificable: false, deps: { consultar: base.consultar, hoy: HOY } });
    const r = await h.lista[0].ejecutar({});
    prueba('🔒 canal no verificable (panel, IG, Messenger): no consulta nada', r === NO_VERIFICABLE && base.consultas.length === 0 && h.cargaConsultada() === null);
  }
  {
    const h = crearHerramientas({ telefono: TEL.compartido, canalVerificable: true, deps: { consultar: baseDeMentira().consultar, hoy: HOY } });
    const r = await h.lista[0].ejecutar({});
    prueba('🔒 número en varios clientes: no lista cargas', h.cargaConsultada().estado === 'varios_clientes' && !/Tiene \d+ carga/.test(r) && r !== 'null');
  }
  {
    const h = crearHerramientas({ telefono: TEL.sin_carga, canalVerificable: true, deps: { consultar: baseDeMentira().consultar, hoy: HOY } });
    const r = await h.lista[0].ejecutar({});
    prueba('sin carga: lo dice (no devuelve «null»)', h.cargaConsultada().estado === 'sin_carga' && r.length > 20 && r !== 'null');
  }
  {
    const h = crearHerramientas({ telefono: TEL.transito_con_fecha, mensaje: 'y la cotización 99999?', canalVerificable: true, deps: { consultar: baseDeMentira().consultar, hoy: HOY } });
    const r = await h.lista[0].ejecutar({});
    prueba('🔒 una cotización ajena escrita por el cliente sale marcada como ajena', /99999/.test(r));
  }
  {
    const h = crearHerramientas({ telefono: TEL.aduana, canalVerificable: true });
    const p = h.lista[1];
    prueba('pasar_a_humano devuelve el texto exacto del asesor', (await p.ejecutar({ motivo: 'pago' })) === `Responde exactamente: ${T.MENSAJE_ASESOR}`);
    prueba('…y el de reclamo si es un reclamo', (await p.ejecutar({ motivo: 'reclamo' })) === `Responde exactamente: ${T.MENSAJE_RECLAMO}`);
  }

  /* ───────────────────────────────────────────────────────────────────── */
  console.log('\n4. La guardia con lo que trajo la herramienta (la misma función que usa el motor en el 9.5)');
  const real = buscadorDeArchivo();
  const turnoSinCarga = (mensaje, tel) =>
    prepararTurno({ mensaje, telefono: tel, tipo_mensaje: 'text', id_configuracion: 265, id_cliente: tel,
      opciones: { cargas: false, fichas: true, guardia: true, herramientas: true }, deps: { consultar: baseDeMentira().consultar, hoy: HOY, buscador: real } });
  {
    olvidarTodo();
    const msg = 'y lo mío cuándo?';
    const h = crearHerramientas({ telefono: TEL.transito_con_fecha, mensaje: msg, canalVerificable: true, deps: { consultar: baseDeMentira().consultar, hoy: HOY } });
    const bloque = await h.lista[0].ejecutar({});
    const respuesta = textoParaCliente(h.cargaConsultada(), T.MENSAJE_ASESOR);

    const sinSumar = await turnoSinCarga(msg, TEL.transito_con_fecha);
    const revSin = revisarTurno(respuesta, sinSumar.hechos);
    prueba('sin sumar lo de la herramienta, la guardia reemplaza el estado de la carga', revSin.cambiada === true, revSin.motivos.join('; '));

    olvidarTodo();
    const t = await turnoSinCarga(msg, TEL.transito_con_fecha);
    sumarHechosHerramientas(t.hechos, [bloque], h.cargaConsultada(), { mensaje: msg, respuesta });
    const rev = revisarTurno(respuesta, t.hechos);
    prueba('sumándolo, el estado y la fecha que trajo la herramienta pasan', rev.cambiada === false, rev.motivos.join('; '));
    prueba('el texto seguro pasa a ser el estado real de la carga', t.hechos.textoSeguro === respuesta);

    const inventada = 'Tu contenedor está en tránsito y llega el 3 de diciembre.';
    const revInv = revisarTurno(inventada, t.hechos);
    prueba('una fecha que la herramienta no trajo se sigue frenando', revInv.cambiada === true, revInv.motivos.join('; '));
  }

  {
    // Revisión 1: una ficha que explica los pasos (dice «en aduana») no respalda
    // el estado de ESTA carga cuando la carga llegó por la herramienta.
    olvidarTodo();
    const msg = 'cuáles son los pasos de la carga? y lo mío?';
    const h = crearHerramientas({ telefono: TEL.transito_con_fecha, mensaje: msg, canalVerificable: true, deps: { consultar: baseDeMentira().consultar, hoy: HOY } });
    const bloque = await h.lista[0].ejecutar({});
    const t = await turnoSinCarga(msg, TEL.transito_con_fecha);
    const conFicha = /aduana/i.test(t.hechos.respaldo.firme);
    sumarHechosHerramientas(t.hechos, [bloque], h.cargaConsultada(), { mensaje: msg, respuesta: 'Tu carga está en aduana.' });
    const rev = revisarTurno('Tu carga está en aduana.', t.hechos);
    prueba('🔒 un estado que contradice la herramienta se frena aunque una ficha diga «aduana»', conFicha && rev.cambiada === true, `ficha con aduana: ${conFicha}; ${rev.motivos.join('; ')}`);
    const real2 = textoParaCliente(h.cargaConsultada(), T.MENSAJE_ASESOR);
    prueba('…y el estado real sigue pasando', revisarTurno(real2, t.hechos).cambiada === false);
  }
  {
    // Revisión 4: si nadie habló de la carga, el texto seguro sigue siendo el del asesor.
    olvidarTodo();
    const msg = 'cuánto debo?';
    const h = crearHerramientas({ telefono: TEL.transito_con_fecha, mensaje: msg, canalVerificable: true, deps: { consultar: baseDeMentira().consultar, hoy: HOY } });
    const bloque = await h.lista[0].ejecutar({});
    const t = await turnoSinCarga(msg, TEL.transito_con_fecha);
    sumarHechosHerramientas(t.hechos, [bloque], h.cargaConsultada(), { mensaje: msg, respuesta: 'Debes 350 dólares.' });
    prueba('una pregunta de cobranza no se contesta con el estado de la carga', t.hechos.textoSeguro === T.MENSAJE_ASESOR);
  }
  {
    // Revisión 2: con la carga apagada en la cuenta, ver_mi_carga no se ofrece.
    const h = crearHerramientas({ telefono: TEL.transito_con_fecha, canalVerificable: true, cargas: false });
    prueba('🔒 con `cargas: false` solo queda pasar_a_humano', h.lista.map((x) => x.definicion.name).join() === 'pasar_a_humano');
  }

  /* ───────────────────────────────────────────────────────────────────── */
  console.log('\n5. El simulador con herramientas (cliente falso, de punta a punta)');
  {
    olvidarTodo();
    const { crearLlamadorClaude, responderTurno } = require('./soporte_expertos/bot_real');
    const base = baseDeMentira();
    // El modelo pide la carga y contesta copiando el estado real que le llegó.
    let estadoReal = null;
    const c = clienteFalso([pide(['ver_mi_carga', {}]), { stop_reason: 'end_turn', get content() { return [{ type: 'text', text: estadoReal }]; } }]);
    const sim = crearLlamadorClaude({ cliente: c, modelo: 'claude-opus-5-5', herramientas: true });
    prueba('el prompt del simulador lleva la sección de herramientas', sim.instructions.includes(SECCION_HERRAMIENTAS));
    const directa = await cargasDelTelefono(TEL.transito_con_fecha, { consultar: baseDeMentira().consultar, hoy: HOY });
    estadoReal = textoParaCliente(directa, T.MENSAJE_ASESOR);
    const r = await responderTurno({
      telefono: TEL.transito_con_fecha, id_cliente: 'sim1', mensaje: 'hola, y mi contenedor?', llamar: sim.llamar,
      consultar: base.consultar, buscador: real, hoy: HOY,
    });
    prueba('usa el bucle con herramientas (2 llamadas)', r.llamadas === 2 && c.pedidos[0].tools?.length === 2);
    prueba('la herramienta consultó la carga del remitente', base.consultas.length > 0);
    prueba('la guardia deja pasar el estado que trajo la herramienta', r.guardia.cambiada === false && r.crudo === estadoReal, r.guardia.motivos?.join('; '));
    const r2 = await responderTurno({
      telefono: TEL.transito_con_fecha, id_cliente: 'sim1', mensaje: 'gracias', llamar: sim.llamar, previous_response_id: r.response_id,
      consultar: base.consultar, buscador: real, hoy: HOY, doble: null,
    }).catch((e) => ({ error: e.message }));
    prueba('el turno siguiente lleva la conversación anterior', r2.error === 'el guion se acabó' && c.pedidos[2].messages.length === 3 && c.pedidos[2].messages[1].role === 'assistant');
  }

  /* ───────────────────────────────────────────────────────────────────── */
  console.log('\n6. Prompt');
  prueba('la sección de herramientas existe y está en tuteo', /ver_mi_carga/.test(SECCION_HERRAMIENTAS) && !/\b(Tocá|Tenés|Podés|Hacé|Mirá|Usá|Pedí|Respondé)\b/.test(SECCION_HERRAMIENTAS));
  prueba('dice que nunca se pide el teléfono', /Nunca le pidas su número/.test(SECCION_HERRAMIENTAS));

  console.log(`\n${fallos ? `HAY FALLAS: ${fallos} fallan, ${ok} pasan` : `TODO BIEN: ${ok} pasan, 0 fallan`}`);
  process.exit(fallos ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
