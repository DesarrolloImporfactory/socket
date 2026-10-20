/**
 * Prueba el asistente de comentarios SIN tocar Facebook.
 *
 * Toda la parte cara de esto —decidir si hay una respuesta rápida que sirva,
 * armar el contexto del producto, redactar el borrador— pasa entre la base y
 * OpenAI. Facebook solo entra al final, cuando un agente le da a publicar. Así
 * que se puede afinar entero en local, que es justo lo que hace falta mientras
 * la app está en revisión y no conviene publicar nada.
 *
 * Uso:
 *   node scripts/probarSugerenciaComentarios.js --cfg 10 --producto 4112 \
 *        "¿qué incluye la compra?"
 *
 *   # varias preguntas de una, para ver el comportamiento en conjunto
 *   node scripts/probarSugerenciaComentarios.js --cfg 10 --producto 4112 \
 *        "hola" "¿cuánto cuesta?" "¿sirve para iPhone?" "me encanta 😍"
 *
 *   # sin --producto: simula una publicación sin vincular (el nivel 3)
 *   node scripts/probarSugerenciaComentarios.js --cfg 10 "¿cuánto cuesta?"
 *
 *   --ver-contexto   imprime el contexto del producto y las instrucciones
 *                    completas que recibe el modelo
 *   --sin-ia         solo prueba las respuestas rápidas (no llama a OpenAI)
 *
 * Lo que NO prueba: publicar en Facebook, el webhook y la insignia de origen en
 * la bandeja. Eso necesita un comentario real.
 */
require('dotenv').config();

const { db } = require('../src/database/config');
const {
  cargarProductoPorId,
  cargarVariaciones,
  bloqueProducto,
} = require('../src/utils/comentarios/contextoProducto');
const {
  elegirRespuestaRapida,
} = require('../src/utils/wizardProducto/respuestasRapidas');
const { leerApiKeyOpenAI } = require('../src/utils/openia/apiKeyOpenAI');
const {
  partirSalida,
  prometePrivado,
} = require('../src/utils/comentarios/promptComentarios');

/* Las instrucciones se piden al mismo sitio que las pide el servidor, para que
   esto pruebe lo que de verdad corre y no una copia. Incluye la configuración
   propia de la cuenta si la tiene. */
const {
  cargarInstruccionesComentarios,
} = require('../src/services/facebook_comments.service');

function leerArgs(argv) {
  const out = { cfg: null, producto: null, textos: [], verContexto: false, sinIa: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--cfg') out.cfg = Number(argv[++i]);
    else if (a === '--producto') out.producto = Number(argv[++i]);
    else if (a === '--ver-contexto') out.verContexto = true;
    else if (a === '--sin-ia') out.sinIa = true;
    else out.textos.push(a);
  }
  return out;
}

const linea = (c = '─') => console.log(c.repeat(72));

async function main() {
  const args = leerArgs(process.argv.slice(2));

  if (!args.cfg || !args.textos.length) {
    console.log(
      'Falta algo. Ejemplo:\n' +
        '  node scripts/probarSugerenciaComentarios.js --cfg 10 --producto 4112 "¿qué incluye?"',
    );
    process.exit(1);
  }

  const [cfg] = await db.query(
    `SELECT api_key_openai, nombre_configuracion
       FROM configuraciones WHERE id = ? LIMIT 1`,
    { replacements: [args.cfg], type: db.QueryTypes.SELECT },
  );
  if (!cfg) {
    console.error(`No existe la configuración ${args.cfg}`);
    process.exit(1);
  }

  const asistente = await cargarInstruccionesComentarios(args.cfg);

  let prod = null;
  if (args.producto) {
    prod = await cargarProductoPorId({
      id_configuracion: args.cfg,
      id_producto: args.producto,
    });
    if (!prod) {
      console.error(
        `El producto ${args.producto} no existe en la configuración ${args.cfg}`,
      );
      process.exit(1);
    }
  }

  linea('═');
  console.log(`Cuenta:   ${cfg.nombre_configuracion || '(sin nombre)'} (cfg ${args.cfg})`);
  console.log(`Prompt:   ${asistente.usando}`);
  console.log(
    `Producto: ${prod ? `${prod.nombre} (id ${prod.id})` : '(sin vincular — nivel 3)'}`,
  );
  if (prod) {
    console.log(
      `Rápidas:  ${prod.faqs.length} activas · interruptor ${
        prod.usar_respuestas_rapidas ? 'encendido' : 'APAGADO'
      }`,
    );
  }
  linea('═');

  let bloque = null;
  if (prod) {
    const variaciones = prod.es_variable ? await cargarVariaciones(prod.id) : [];
    bloque = bloqueProducto(prod, variaciones);
    if (args.verContexto) {
      console.log('\nCONTEXTO QUE RECIBE EL MODELO');
      linea();
      console.log(bloque);
      linea();
      console.log(`(${bloque.length} caracteres)\n`);
    }
  }

  if (args.verContexto) {
    console.log('INSTRUCCIONES DEL ASISTENTE');
    linea();
    console.log(asistente.instrucciones);
    linea();
    console.log('');
  }

  const apiKey = leerApiKeyOpenAI(cfg.api_key_openai);
  if (!apiKey && !args.sinIa) {
    console.log(
      '\n⚠️  Esta cuenta no tiene clave de OpenAI. Solo se prueban las' +
        ' respuestas rápidas.\n',
    );
  }

  let quemadas = 0;
  let conIa = 0;
  let conPrivado = 0;

  for (const texto of args.textos) {
    console.log(`\n💬 "${texto}"`);

    /* ── nivel 1 ── */
    if (prod?.usar_respuestas_rapidas && prod.faqs.length) {
      const match = elegirRespuestaRapida(texto, prod.faqs);
      if (match?.faq?.respuesta) {
        quemadas += 1;
        console.log(`   ⚡ RESPUESTA RÁPIDA (score ${match.score}) · 0 tokens`);
        console.log(`   pregunta: ${match.faq.pregunta}`);
        console.log(`   → ${String(match.faq.respuesta).trim()}`);
        continue;
      }
    }

    if (args.sinIa || !apiKey) {
      console.log('   · sin respuesta rápida → iría a la IA');
      continue;
    }

    /* ── niveles 2 y 3 ── */
    const entrada = [
      `Negocio: ${cfg.nombre_configuracion || '(sin nombre)'}`,
      bloque,
      bloque
        ? 'Si preguntan por OTRO producto distinto a este, no sabes si el ' +
          'negocio lo vende: no afirmes ni niegues. Dile que le escribes al ' +
          'privado y ahí se lo confirman.'
        : 'No sabes de qué producto habla esta publicación. No des precios ni ' +
          'características: reconoce el comentario e invítalo al privado.',
      `Comentario de un cliente: ${texto}`,
    ]
      .filter(Boolean)
      .join('\n\n');

    const { ejecutarConResponsesAPI } = require('../src/services/kanban_ia.service');

    const t0 = Date.now();
    try {
      const r = await ejecutarConResponsesAPI({
        instructions: asistente.instrucciones,
        input: entrada,
        model: 'gpt-4o-mini',
        max_tokens: 200,
        api_key_openai: apiKey,
        id_configuracion: args.cfg,
      });
      const salida = String(r?.respuesta || r?.text || r || '').trim();
      conIa += 1;

      /* El modelo devuelve el comentario público y el privado en la misma
         llamada. Se separan con el MISMO parser que usa el servicio, así que si
         acá se ve bien, en producción sale bien. */
      const { comentario, privado } = partirSalida(salida);
      if (privado) conPrivado += 1;

      console.log(
        `   🤖 IA ${prod ? 'con producto' : 'SIN producto'} · ${Date.now() - t0} ms`,
      );
      console.log(`   💬 público  → ${comentario}`);
      if (privado) {
        const prometido = prometePrivado(comentario);
        console.log(
          `   ${prometido ? '🔒' : '○ '} privado${prometido ? ' ' : ' (cortesía, va desmarcado)'} → ${privado}`,
        );
        if (prod) {
          console.log(
            `   🔗 puente   → ancla "${prod.nombre}" + estado contacto_inicial`,
          );
        }
      }
    } catch (err) {
      console.log(`   ❌ falló la IA: ${err.message}`);
    }
  }

  console.log('');
  linea('═');
  console.log(
    `${args.textos.length} comentarios · ${quemadas} resueltos por respuesta ` +
      `rápida (gratis) · ${conIa} con IA · ${conPrivado} con privado`,
  );
  linea('═');

  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
