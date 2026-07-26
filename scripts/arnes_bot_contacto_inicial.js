/* Arnés de pruebas del bot de Contacto Inicial (cfg 610).
   Replica el endpoint /kanban_columnas/chat_prueba (misma Responses API, mismo
   vector store, misma api key) pero con un prompt CANDIDATO leído de archivo,
   sin tocar la columna real. Corre escenarios y verifica reglas.

   Uso: node arnes_bot.js <ruta_prompt.txt> [soloEscenario] */
require('dotenv').config({
  
});
const fs = require('fs');
const _a = require('axios');
const axios = _a.default || _a;
const { db } = require('../src/database/config');

const PROMPT_FILE = process.argv[2];
const SOLO = process.argv[3] && process.argv[3] !== 'todos' ? process.argv[3] : null;
const MODELO_OVERRIDE = process.argv[4] || null; // p.ej. gpt-4o

/* ── Escenarios: [mensajes del cliente] + verificaciones por turno ── */
const RE_TAG = /\[generar_guia\]:true/i;
const RE_RESUMEN = /🧑\s*Nombre:/;
const tiene = (t, re) => re.test(t);

const ESCENARIOS = require('./escenarios_v7.js')({ RE_TAG, RE_RESUMEN, tiene });

/* ── Reglas globales, en cualquier turno ── */
function checksGlobales(turnos) {
  const e = [];
  const todo = turnos.join('\n───\n');
  // Placeholders/relleno: solo son error DENTRO de un mensaje con resumen
  // (pedir "por favor proporciona tu nombre" en un turno normal es legítimo).
  for (const t of turnos)
    if (
      RE_RESUMEN.test(t) &&
      /\[nombre|\[tel[eé]fono|\[direcci|\(falta\)|\(pendiente\)|no proporcionad|por favor proporciona|según tu elección/i.test(t)
    )
      e.push('usó placeholders o texto de relleno en un resumen');
  if (/stock\s*\d|\(stock/i.test(todo)) e.push('mencionó stock');
  // Huecos dentro del resumen (línea en blanco entre campos): ruido visual
  // que además delata líneas omitidas a medias.
  for (const t of turnos)
    if (
      RE_TAG.test(t) &&
      /(🧑|📞|📍|🏡|📦|🎨|🔢|💰|🚚)[^\n]*\n\s*\n\s*(📞|📍|🏡|📦|🎨|🔢|💰|🚚)/.test(t)
    )
      e.push('resumen con líneas en blanco entre campos');
  if (/aqu[ií] tienes (la|una) imagen|en l[ií]nea separada|te dejo la foto/i.test(todo))
    e.push('anunció la imagen con frase introductoria');
  const cierres = turnos.filter((t) => RE_TAG.test(t)).length;
  if (cierres > 1) e.push(`puso [generar_guia]:true en ${cierres} turnos (debe ser 1)`);
  for (const t of turnos) {
    if (RE_TAG.test(t) && !RE_RESUMEN.test(t)) e.push('tag sin resumen en el mismo mensaje');
    if (RE_RESUMEN.test(t) && !RE_TAG.test(t)) e.push('resumen sin tag (resumen a medias)');
    if (RE_TAG.test(t)) {
      // Líneas que el auto-orden lee sí o sí
      for (const [nombre, re] of [
        ['Provincia', /📍\s*Provincia:\s*\S/],
        ['Ciudad', /📍\s*Ciudad:\s*\S/],
        ['Direccion', /🏡\s*Direcci[oó]n:\s*\S/],
        ['Producto', /📦\s*Producto:\s*\S/],
        ['Precio total', /💰\s*Precio total:\s*\S/],
        ['Envio', /🚚\s*Env[ií]o:\s*\S/],
      ])
        if (!re.test(t)) e.push(`resumen final sin línea "${nombre}"`);
    }
  }
  return e;
}

(async () => {
  if (!PROMPT_FILE || !fs.existsSync(PROMPT_FILE)) {
    console.error('Uso: node arnes_bot.js <ruta_prompt.txt>');
    process.exit(1);
  }
  const instrucciones = fs.readFileSync(PROMPT_FILE, 'utf8');

  const [col] = await db.query(
    `SELECT kc.id, kc.modelo, kc.vector_store_id, c.api_key_openai
       FROM kanban_columnas kc
       JOIN configuraciones c ON c.id = kc.id_configuracion
      WHERE kc.id_configuracion = 610 AND kc.estado_db = 'contacto_inicial'
        AND kc.activo = 1 LIMIT 1`,
    { type: db.QueryTypes.SELECT },
  );
  if (!col?.api_key_openai) {
    console.error('cfg 610 sin columna contacto_inicial o sin api key');
    process.exit(1);
  }
  console.log(`columna ${col.id} · modelo ${col.modelo || 'gpt-4o-mini'} · vector ${col.vector_store_id ? 'sí' : 'NO'}`);
  console.log(`prompt candidato: ${PROMPT_FILE} (${instrucciones.length} chars)\n`);

  const headers = {
    Authorization: `Bearer ${col.api_key_openai}`,
    'Content-Type': 'application/json',
  };
  const tools = col.vector_store_id
    ? [{ type: 'file_search', vector_store_ids: [col.vector_store_id] }]
    : [];

  let totalFallas = 0;
  let tokIn = 0, tokOut = 0, llamadas = 0;
  for (const esc of ESCENARIOS) {
    if (SOLO && esc.nombre !== SOLO) continue;
    process.stdout.write(`▶ ${esc.nombre} `);
    const turnos = [];
    let prev = null;
    try {
      for (const msg of esc.mensajes) {
        const body = {
          model: MODELO_OVERRIDE || col.modelo || 'gpt-4o-mini',
          instructions: instrucciones,
          input: msg,
          store: true,
          ...(tools.length && { tools }),
          ...(prev && { previous_response_id: prev }),
        };
        // 429 (TPM de la org): esperar lo que pida OpenAI y reintentar.
        let data;
        for (let intento = 0; ; intento++) {
          try {
            ({ data } = await axios.post('https://api.openai.com/v1/responses', body, {
              headers,
              timeout: 140000,
            }));
            break;
          } catch (err) {
            const msg429 = err.response?.data?.error?.message || '';
            if (err.response?.status === 429 && intento < 5) {
              const seg = Number(msg429.match(/try again in ([\d.]+)s/)?.[1]) || 15;
              await new Promise((r) => setTimeout(r, (seg + 2) * 1000));
              continue;
            }
            throw err;
          }
        }
        tokIn += data.usage?.input_tokens || 0;
        tokOut += data.usage?.output_tokens || 0;
        llamadas += 1;
        await new Promise((r) => setTimeout(r, 2500)); // ritmo entre turnos
        prev = data.id;
        const texto =
          data.output_text ||
          data.output
            ?.filter((o) => o.type === 'message')
            ?.flatMap((o) => o.content)
            ?.filter((c) => c.type === 'output_text')
            ?.map((c) => c.text)
            ?.join('') ||
          '';
        turnos.push(texto);
        process.stdout.write('.');
      }
    } catch (err) {
      console.log(` ✖ error API: ${err.response?.data?.error?.message || err.message}`);
      totalFallas += 1;
      continue;
    }

    const fallas = [...esc.checks(turnos), ...checksGlobales(turnos)];
    if (!fallas.length) console.log(' ✔ PASA');
    else {
      console.log(` ✖ ${fallas.length} falla(s):`);
      for (const f of fallas) console.log(`     - ${f}`);
      totalFallas += fallas.length;
      console.log('   ── transcripción ──');
      turnos.forEach((t, i) =>
        console.log(`   [bot ${i + 1}] ${t.replace(/\n/g, ' ⏎ ').slice(0, 320)}`),
      );
    }
  }
  console.log(`\n📊 tokens: ${tokIn} entrada + ${tokOut} salida en ${llamadas} llamadas`);
  console.log(`\n${totalFallas === 0 ? '✅ TODOS LOS ESCENARIOS PASAN' : `❌ ${totalFallas} fallas en total`}`);
  process.exit(totalFallas === 0 ? 0 : 1);
})().catch((e) => {
  console.error('ERROR:', e.message);
  process.exit(1);
});
