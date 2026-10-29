/**
 * Claude con herramientas: el modelo puede pedir un dato a mitad de la
 * respuesta (por ejemplo, la carga del cliente) y contesta con lo que trae.
 *
 * Es aparte de `ejecutarConClaude` a propósito: esa la usan todas las cuentas
 * con Claude (kanban, wizard de productos, remarketing) y no cambia. Esta solo
 * corre cuando la cuenta tiene `ajustes.soporte_expertos.herramientas`.
 *
 * Cada herramienta es { definicion: {name, description, input_schema},
 * ejecutar: async (input) => string }. Lo que identifica al cliente (su
 * número) lo cierra quien arma la herramienta: el modelo nunca lo elige.
 *
 * Como máximo `maxLlamadas` llamadas por turno: hasta 2 rondas de herramientas
 * y la respuesta. En la última se manda `tool_choice: none`, así que siempre
 * llega texto. Lo que devolvieron las herramientas sale en
 * `hechosHerramientas` para que la guardia lo dé por respaldado.
 */
const { cliente, modeloClaude, opcionesPorModelo, PISO_MAX_TOKENS } = require('./claude');

const TOPE_HERRAMIENTA_MS = 8000;
const TOPE_TURNO_MS = 30000;
const MAX_CAR_RESULTADO = 4000;

function conTope(promesa, ms, mensaje = 'tiempo agotado') {
  let t;
  return Promise.race([
    Promise.resolve(promesa),
    new Promise((_, rej) => {
      t = setTimeout(() => rej(new Error(mensaje)), ms);
    }),
  ]).finally(() => clearTimeout(t));
}

function textoDe(res) {
  return (res.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim();
}

async function ejecutarConClaudeHerramientas({
  instructions,
  additional_instructions,
  input,
  model,
  max_tokens,
  api_key_claude,
  log,
  herramientas = [],
  maxLlamadas = 3,
  mensajesPrevios = [],
  deps = {},
}) {
  const client = deps.client || cliente(api_key_claude);
  const modelo = modeloClaude(model);
  // Pasado el tope del turno, el bucle se detiene: no hace más llamadas
  // pagadas, no corre herramientas y no escribe más en el log del turno.
  const control = new AbortController();
  const cortado = () => control.signal.aborted;
  const anotar = async (t) => {
    if (cortado()) return;
    if (typeof log === 'function') await Promise.resolve(log(t)).catch(() => {});
  };

  let system = String(instructions || '');
  if (additional_instructions) system += '\n\n' + additional_instructions;

  const porNombre = Object.fromEntries(herramientas.map((h) => [h.definicion.name, h]));
  const defs = herramientas.map((h) => h.definicion);
  const base = {
    model: modelo,
    max_tokens: Math.max(Number(max_tokens) || 0, PISO_MAX_TOKENS),
    output_config: { effort: 'low' },
    ...opcionesPorModelo(modelo),
    system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
  };

  const messages = [...mensajesPrevios, { role: 'user', content: String(input || '') }];
  const hechos = [];
  const usage = { modelo, input: 0, cached: 0, output: 0, reasoning: 0 };
  let cacheEscrito = 0; // aparte de `usage` (que tiene la forma de ejecutarConClaude): lo usa el simulador
  const sumar = (u = {}) => {
    cacheEscrito += Number(u.cache_creation_input_tokens) || 0;
    usage.input += (Number(u.input_tokens) || 0) + (Number(u.cache_read_input_tokens) || 0) + (Number(u.cache_creation_input_tokens) || 0);
    usage.cached += Number(u.cache_read_input_tokens) || 0;
    usage.output += Number(u.output_tokens) || 0;
  };
  const salida = (respuesta, res, llamadas) => ({
    respuesta,
    response_id: res?.id || null,
    total_tokens: usage.input + usage.output,
    usage,
    hechosHerramientas: hechos,
    llamadas,
    cacheEscrito,
  });

  const t0 = Date.now();
  const bucle = async () => {
    let res = null;
    for (let n = 1; n <= maxLlamadas; n++) {
      if (cortado()) return null;
      const ultima = n === maxLlamadas;
      const t = Date.now();
      res = await client.beta.messages.create(
        {
          ...base,
          ...(defs.length ? { tools: defs } : {}),
          ...(defs.length && ultima ? { tool_choice: { type: 'none' } } : {}),
          messages,
        },
        { signal: control.signal },
      );
      if (cortado()) return null;
      sumar(res.usage);
      const respaldo = (res.content || []).find((b) => b.type === 'fallback');
      await anotar(
        `⏱️ Claude ${res.model || modelo} (llamada ${n}/${maxLlamadas}): ${Date.now() - t} ms · stop=${res.stop_reason}` +
          (respaldo ? ` · respaldo ${respaldo.from?.model} → ${respaldo.to?.model}` : ''),
      );

      if (res.stop_reason === 'refusal') {
        await anotar(`🚫 Claude declinó responder (${res.stop_details?.category || 'sin categoría'})`);
        return salida('', res, n);
      }
      if (res.stop_reason !== 'tool_use') return salida(textoDe(res), res, n);

      // El turno del modelo se reenvía tal cual (pensamiento incluido); los
      // bloques `fallback` son del servidor, no del modelo, y no se reenvían.
      messages.push({ role: 'assistant', content: (res.content || []).filter((b) => b.type !== 'fallback') });
      const resultados = [];
      for (const b of (res.content || []).filter((x) => x.type === 'tool_use')) {
        if (cortado()) return null;
        const h = porNombre[b.name];
        let texto;
        let error = false;
        try {
          if (!h) {
            texto = 'Herramienta desconocida.';
            error = true;
          } else {
            texto = await conTope(h.ejecutar(b.input || {}), TOPE_HERRAMIENTA_MS);
          }
        } catch (e) {
          texto = 'No se pudo consultar ahora.';
          error = true;
          await anotar(`⚠️ herramienta ${b.name} falló: ${e.message}`);
        }
        texto = String(texto ?? '').slice(0, MAX_CAR_RESULTADO) || 'Sin datos.';
        if (!error) hechos.push(texto);
        resultados.push({ type: 'tool_result', tool_use_id: b.id, content: texto, is_error: error });
        await anotar(`🛠️ ${b.name} → ${error ? 'error' : `${texto.length} car.`}`);
      }
      messages.push({ role: 'user', content: resultados });
    }
    return salida(textoDe(res), res, maxLlamadas);
  };

  try {
    const enCurso = bucle();
    // Si se corta por tiempo, la llamada en vuelo termina en error al abortarla:
    // se atrapa aquí para que no quede un rechazo sin atender (tumba el proceso).
    enCurso.catch(() => {});
    const r = await conTope(enCurso, deps.topeTurnoMs || TOPE_TURNO_MS, 'turno con herramientas: tiempo agotado');
    await anotar(`🛠️ turno con herramientas: ${r.llamadas} llamada(s), ${hechos.length} dato(s), ${Date.now() - t0} ms`);
    return r;
  } catch (e) {
    if (/tiempo agotado/.test(e.message)) {
      control.abort(); // primero se corta el bucle; después se deja el aviso
      if (typeof log === 'function') {
        await Promise.resolve(log(`⚠️ ${e.message} (${Date.now() - t0} ms): sin respuesta`)).catch(() => {});
      }
      return { ...salida('', null, 0), hechosHerramientas: [] };
    }
    throw e; // errores de la API: el motor ya los maneja como los de ejecutarConClaude
  }
}

module.exports = { ejecutarConClaudeHerramientas, conTope, TOPE_HERRAMIENTA_MS, TOPE_TURNO_MS };
