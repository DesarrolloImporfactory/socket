// scripts/probar_claude_fase2.js
// Fase 2 Claude: todo lo que antes seguía en OpenAI aunque la cuenta
// respondiera con Claude. Sin --real corre en seco (sin tocar la API):
// extractor de texto de archivos, bloque de documentos, helpers. Con --real
// usa la llave de Claude de la cuenta (--config=10 por defecto) y gasta
// centavos: extractor JSON (auto-orden / ficha), esquemas de novedades y
// wizard, visión, chat de prueba interno.
//
//   node scripts/probar_claude_fase2.js
//   node scripts/probar_claude_fase2.js --real [--config=10] [--columna=10916]
'use strict';

require('dotenv').config();
const fs = require('fs');
const path = require('path');

const arg = (n) => {
  const m = process.argv.find((a) => a.startsWith(`--${n}=`));
  return m ? m.split('=').slice(1).join('=') : null;
};
const REAL = process.argv.includes('--real');
const CFG = Number(arg('config')) || 10;
const COL = Number(arg('columna')) || 10916;

let pasan = 0;
let fallan = 0;
function ok(nombre, cond, detalle = '') {
  if (cond) {
    pasan += 1;
    console.log(`  ✓ ${nombre}${detalle ? ` — ${detalle}` : ''}`);
  } else {
    fallan += 1;
    console.log(`  ✗ ${nombre}${detalle ? ` — ${detalle}` : ''}`);
  }
}

async function enSeco() {
  console.log('\n[1] Extractor de texto de archivos (utils/claude/textoDeArchivo.js)');
  const { extraerTexto } = require('../src/utils/claude/textoDeArchivo');
  const txt = await extraerTexto(Buffer.from('Política de envíos\n\nEnviamos a todo el país.'), {
    mime: 'text/plain',
    nombre: 'politicas.txt',
  });
  ok('TXT se lee', txt?.texto.includes('Enviamos a todo el país'), `${txt?.chars} chars`);
  const XLSX = require('xlsx');
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.aoa_to_sheet([
      ['Producto', 'Precio'],
      ['Reloj', 45],
    ]),
    'Precios',
  );
  const x = await extraerTexto(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }), {
    mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    nombre: 'p.xlsx',
  });
  ok('XLSX una línea por fila', x?.texto === 'Producto | Precio\nReloj | 45', JSON.stringify(x?.texto));
  const html = await extraerTexto(Buffer.from('<html><body><h1>Hola</h1><p>Envío <b>gratis</b></p><script>x()</script></body></html>'), {
    mime: 'text/html',
    nombre: 'a.html',
  });
  ok('HTML sin etiquetas', /Hola\s+Envío gratis/.test(html?.texto || '') && !/x\(\)/.test(html?.texto || ''), JSON.stringify(html?.texto));
  const pdfLocal = fs
    .readdirSync(path.join(__dirname, '..', 'src', 'uploads', 'productos', 'documento'))
    .find((f) => f.endsWith('.pdf'));
  if (pdfLocal) {
    const pdf = await extraerTexto(
      fs.readFileSync(path.join(__dirname, '..', 'src', 'uploads', 'productos', 'documento', pdfLocal)),
      { mime: 'application/pdf', nombre: pdfLocal },
    );
    ok('PDF se lee (pdf-parse)', Boolean(pdf?.chars > 50), `${pdf?.chars} chars`);
  }
  const pptx = await extraerTexto(Buffer.from('zip'), {
    mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    nombre: 'a.pptx',
  });
  ok('PPTX devuelve null (no se lee)', pptx === null);

  console.log('\n[2] Bloque de documentos para el prompt (utils/claude/documentos.js)');
  const d = require('../src/utils/claude/documentos');
  const b = d.armarBloqueDocumentos([
    { nombre: 'politicas.txt', texto: 'Envíos a todo el país en 2 a 4 días.' },
    { nombre: 'grande.txt', texto: 'x'.repeat(70000) },
  ]);
  ok('respeta el tope', b.length <= d.TOPE_CHARS_DOCS + 600, `${b.length} chars`);
  ok('incluye el puente y el primer doc entero', b.includes(d.PUENTE_DOCS) && b.includes('=== politicas.txt ==='));
  ok('avisa el recorte', /recortado/.test(b) && /no cupieron/.test(b));
  ok('sin docs → vacío', d.armarBloqueDocumentos([]) === '');

  console.log('\n[3] Helpers de proveedor');
  const c = require('../src/utils/claude/claude');
  ok('usaClaude exige proveedor y llave', c.usaClaude({ proveedor_ia: 'claude', api_key_claude: 'k' }) && !c.usaClaude({ proveedor_ia: 'claude' }) && !c.usaClaude({ proveedor_ia: 'openai', api_key_claude: 'k' }));
  ok('parsearJsonTolerante rescata fences', c.parsearJsonTolerante('```json\n{"a":1}\n```')?.a === 1 && c.parsearJsonTolerante('Aquí va: {"b":2} fin')?.b === 2 && c.parsearJsonTolerante('nada') === null);
  const { llaveTranscripcion } = require('../src/utils/openia/transcribirAudio');
  ok('audios: solo con la llave de OpenAI del cliente (sin llave de la casa)', llaveTranscripcion(null) === null && llaveTranscripcion('sk-cliente') === 'sk-cliente');
  const { proveedorExtractor } = require('../src/utils/claude/extractorJson');
  ok('proveedorExtractor', proveedorExtractor({ proveedor_ia: 'claude', api_key_claude: 'k' }) === 'claude' && proveedorExtractor({}) === 'openai');
  const { describirImagenDesdeArchivo } = require('../src/utils/openia/describirImagen');
  ok('visión sin ninguna llave → null', (await describirImagenDesdeArchivo('/uploads/x.jpg', null, {})) === null);
  const { extraerFichaPedido } = require('../src/utils/fichaPedido');
  ok('ficha sin ninguna llave → null', (await extraerFichaPedido({ id_configuracion: 0, id_cliente: 'x', api_key_openai: null })) === null);
}

async function enReal() {
  const c = require('../src/utils/claude/claude');
  const llaves = await c.llavesDeCuenta(CFG);
  console.log(`\n[R] cfg ${CFG}: proveedor=${llaves.proveedor_ia} openai=${llaves.api_key_openai ? 'sí' : 'no'} claude=${llaves.api_key_claude ? 'sí' : 'no'}`);
  if (!llaves.api_key_claude) {
    console.log('  sin llave de Claude: no hay pruebas reales');
    return;
  }
  const k = { proveedor_ia: 'claude', api_key_claude: llaves.api_key_claude };
  let costoTokens = 0;

  console.log('\n[4] Extractor JSON por Claude (auto-orden Dropi / ficha)');
  const { extraerJsonIA } = require('../src/utils/claude/extractorJson');
  const transcript =
    'CLIENTE: hola quiero el reloj\nVENDEDOR: Claro, el Reloj Inteligente X cuesta $45 con envío gratis. ¿Me das tu nombre, ciudad y dirección?\nCLIENTE: Juan Pérez, Otavalo, calle Bolívar 123 junto al parque, mi cel 0991234567\nVENDEDOR: Perfecto. ¿Confirmas el pedido?\nCLIENTE: si correcto';
  const t0 = Date.now();
  const ia = await extraerJsonIA({
    ...k,
    system:
      'Extrae los datos del pedido confirmado de esta conversación de ventas COD en Ecuador. Responde SOLO un JSON con claves: nombre, telefono, provincia, ciudad, direccion, producto, precio_total, cantidad. null si no aparece. provincia: dedúcela de la ciudad.',
    user: transcript,
  });
  ok('extraerJsonIA (claude)', ia?.nombre === 'Juan Pérez' && /Otavalo/i.test(ia?.ciudad) && /Imbabura/i.test(ia?.provincia) && Number(ia?.precio_total) === 45, `${Date.now() - t0} ms · ${JSON.stringify(ia)}`);

  console.log('\n[5] Ficha del pedido por Claude (utils/fichaPedido.js)');
  const { extraerFichaPedido } = require('../src/utils/fichaPedido');
  const lineas = transcript.split('\n').map((l) => l.replace(/^VENDEDOR:/, 'Asistente:').replace(/^CLIENTE:/, 'Cliente:'));
  const textoCliente = lineas.filter((l) => l.startsWith('Cliente:')).map((l) => l.replace('Cliente: ', '')).join('\n');
  const items = lineas.map((l) => ({ rol: l.startsWith('Cliente:') ? 'cliente' : 'bot', texto: l.replace(/^(Cliente|Asistente): /, '') }));
  const t1 = Date.now();
  const ficha = await extraerFichaPedido({
    id_configuracion: CFG,
    id_cliente: `prueba_fase2_${Date.now()}`,
    api_key_openai: null,
    ...k,
    paisNombre: 'Ecuador',
    transcriptExterno: { transcript: lineas.join('\n'), textoCliente, items, firma: 'f1', nCliente: 3 },
  });
  ok('ficha por Claude sin llave de OpenAI', Boolean(ficha) && /Juan/.test(ficha?.nombre || '') && /Otavalo/i.test(ficha?.ciudad || '') && ficha?.telefono === '0991234567', `${Date.now() - t1} ms · ${JSON.stringify(ficha && { nombre: ficha.nombre, ciudad: ficha.ciudad, telefono: ficha.telefono, direccion: ficha.direccion, confirmo: ficha.confirmo_pedido })}`);

  console.log('\n[6] Esquemas estrictos de OpenAI aceptados por la salida estructurada de Claude');
  const { ESQUEMA } = require('../src/services/dropi_novedades_ia.service');
  const t2 = Date.now();
  const nov = await c.claudeJson({
    api_key_claude: llaves.api_key_claude,
    system: 'Eres el asistente logístico. Devuelve la sugerencia para la novedad según el esquema.',
    input: 'NOVEDAD: dirección incompleta. Transportadora SERVIENTREGA. El cliente respondió: "mi dirección es Av. Amazonas N24-03 y Colón, Quito, junto a la farmacia". Campos requeridos: nombre de quien recibe, celular.',
    schema: ESQUEMA,
    max_tokens: 800,
  });
  costoTokens += nov.total_tokens;
  ok('ESQUEMA de novedades Dropi', Boolean(nov.json) && ['proponer', 'pedir_datos', 'escalar'].includes(nov.json?.decision), `${Date.now() - t2} ms · decision=${nov.json?.decision} direccion=${JSON.stringify(nov.json?.direccion)}`);

  const { SCHEMA_TEXTOS } = require('../src/services/producto_wizard.service');
  const t3 = Date.now();
  const wiz = await c.claudeJson({
    api_key_claude: llaves.api_key_claude,
    system: 'Escribes los textos de venta por WhatsApp de un producto a partir de su ficha. Responde según el esquema, en español, breve.',
    input: 'FICHA CRUDA DEL PRODUCTO:\n\nNombre: Reloj Inteligente X. Precio: $45. Envío gratis, pago contra entrega. Beneficios: mide pasos y ritmo cardíaco, batería 7 días, resistente al agua.',
    schema: SCHEMA_TEXTOS,
    model: c.MODELO_REDACTOR,
    max_tokens: 4000,
    effort: 'medium',
  });
  costoTokens += wiz.total_tokens;
  ok('SCHEMA_TEXTOS del wizard (Sonnet)', Boolean(wiz.json) && typeof wiz.json?.intro_mensaje === 'string' && Array.isArray(wiz.json?.respuestas_rapidas), `${Date.now() - t3} ms · intro="${String(wiz.json?.intro_mensaje || '').slice(0, 80)}…" · ${wiz.json?.respuestas_rapidas?.length} FAQs`);

  console.log('\n[7] Visión por Claude (foto del cliente)');
  const { describirImagenDesdeArchivo } = require('../src/utils/openia/describirImagen');
  const dirImg = path.join(__dirname, '..', 'src', 'uploads', 'productos', 'imagen');
  const img = fs.existsSync(dirImg) ? fs.readdirSync(dirImg).find((f) => /\.(jpe?g|png)$/i.test(f)) : null;
  if (img) {
    const t4 = Date.now();
    const desc = await describirImagenDesdeArchivo(`/uploads/productos/imagen/${img}`, null, k);
    ok('describirImagenDesdeArchivo sin llave de OpenAI, con Claude', typeof desc === 'string' && /^\[IMAGEN: (comprobante_pago|producto|direccion|documento|otro)\]/.test(desc), `${Date.now() - t4} ms · ${String(desc).slice(0, 110)}`);
  } else {
    console.log('  · sin imagen local para probar');
  }

  console.log('\n[8] Chat de prueba interno por Claude (kanban_asistente.controller.chat_prueba)');
  const { db } = require('../src/database/config');
  const [col] = await db.query(`SELECT id, nombre FROM kanban_columnas WHERE id = ? AND id_configuracion = ? AND activo = 1 LIMIT 1`, {
    replacements: [COL, CFG],
    type: db.QueryTypes.SELECT,
  });
  if (!col) {
    console.log(`  · columna ${COL} no existe en cfg ${CFG}`);
  } else if (llaves.proveedor_ia !== 'claude') {
    console.log(`  · la cfg ${CFG} responde con OpenAI: el chat de prueba iría por OpenAI (no se gasta)`);
  } else {
    const ctrl = require('../src/controllers/kanban_asistente.controller');
    const llamar = (body) =>
      new Promise((resolve) => {
        const res = { status() { return this; }, json(o) { resolve({ ok: true, body: o }); } };
        ctrl.chat_prueba({ body, user: { id: 0 } }, res, (err) => resolve({ ok: false, err }));
      });
    const t5 = Date.now();
    const r1 = await llamar({ id: col.id, mensaje: 'Hola, buenas tardes', historial: [] });
    ok('turno 1 responde', r1.ok && typeof r1.body?.respuesta === 'string' && r1.body.respuesta.length > 5 && r1.body.response_id === null, `${Date.now() - t5} ms · "${String(r1.body?.respuesta || r1.err?.message).slice(0, 90)}…"`);
    if (r1.ok) {
      /* El bot de soporte de la cfg 10 deja al asesor casi cualquier cosa, así
         que no se puede juzgar la memoria por la respuesta: se captura lo que
         de verdad le llegó a Claude y se comprueba que el recap va adentro. */
      let inputCapturado = "";
      const original = c.ejecutarConClaude;
      c.ejecutarConClaude = async (p) => {
        inputCapturado = String(p.input || "");
        return original(p);
      };
      const t6 = Date.now();
      const r2 = await llamar({
        id: col.id,
        mensaje: '¿Qué te dije hace un momento? Repite mi saludo textual.',
        historial: [
          { rol: 'user', texto: 'Hola, buenas tardes, me llamo Rosa' },
          { rol: 'assistant', texto: r1.body.respuesta },
        ],
      });
      c.ejecutarConClaude = original;
      ok('turno 2 lleva el historial en el input (sin cadena)', r2.ok && inputCapturado.includes("[CONTEXTO DE LA CONVERSACIÓN PREVIA") && /Cliente: Hola, buenas tardes, me llamo Rosa/.test(inputCapturado) && /Asistente: /.test(inputCapturado) && /MENSAJE ACTUAL DEL CLIENTE/.test(inputCapturado), `${Date.now() - t6} ms · input ${inputCapturado.length} chars · "${String(r2.body?.respuesta || r2.err?.message).slice(0, 80)}…"`);
    }
  }


  console.log('\n[9] Documentos de conocimiento: subir → Claude lo lee → borrar (controlador real, columna de prueba)');
  if (col && llaves.proveedor_ia === 'claude') {
    const ctrl = require('../src/controllers/kanban_asistente.controller');
    const d = require('../src/utils/claude/documentos');
    const llamarCtrl = (fn, body, file) =>
      new Promise((resolve) => {
        const res = { status() { return this; }, json(o) { resolve({ ok: true, body: o }); } };
        fn({ body, file, user: { id: 0 } }, res, (err) => resolve({ ok: false, err }));
      });
    const CLAVE = `PRUEBA-FASE2-${Date.now().toString().slice(-6)}`;
    const archivo = {
      originalname: 'politica_prueba_fase2.txt',
      mimetype: 'text/plain',
      buffer: Buffer.from(`POLÍTICA DE GARANTÍA DE PRUEBA\nEl código secreto de garantía es ${CLAVE}. Si el cliente pregunta por el código de garantía, responde exactamente ese código.\n`),
    };
    archivo.size = archivo.buffer.length;

    // a) Con llave de OpenAI (cfg 10 la tiene): va a OpenAI y queda con texto en BD
    const t7 = Date.now();
    const up = await llamarCtrl(ctrl.subirArchivo, { id: col.id }, archivo);
    ok('subir con OpenAI + texto para Claude', up.ok && up.body?.success && up.body?.leido_claude === true && /^file-/.test(up.body?.file_id || ''), `${Date.now() - t7} ms · ${up.ok ? up.body.file_id : up.err?.message}`);
    const bloque = await d.bloqueDocumentosClaude(col.id);
    ok('bloqueDocumentosClaude trae el documento', bloque.docs >= 1 && bloque.bloque.includes(CLAVE), `${bloque.docs} docs, ${bloque.chars} chars`);
    const lista = await llamarCtrl(ctrl.obtenerAsistente, { id: col.id });
    const enLista = (lista.body?.data?.archivos || []).find((a) => a.id === up.body?.file_id);
    ok('la lista lo marca leido_claude', Boolean(enLista) && enLista.leido_claude === true);
    const t8 = Date.now();
    const rq = await llamarCtrl(ctrl.chat_prueba, { id: col.id, mensaje: '¿Cuál es el código secreto de garantía? Dímelo tal cual.', historial: [] });
    ok('Claude responde con lo que dice el documento', rq.ok && String(rq.body?.respuesta || '').includes(CLAVE), `${Date.now() - t8} ms · "${String(rq.body?.respuesta || rq.err?.message).slice(0, 100)}…"`);
    const del = await llamarCtrl(ctrl.eliminarArchivo, { id: col.id, file_id: up.body?.file_id });
    const bloqueDespues = await d.bloqueDocumentosClaude(col.id);
    ok('borrar lo quita de OpenAI y de Claude', del.ok && del.body?.success === true && !bloqueDespues.bloque.includes(CLAVE), `${bloqueDespues.docs} docs quedan`);

    // b) Cuenta SIN llave de OpenAI y con Claude: el archivo queda solo en BD (local_)
    const originalLlaves = c.llavesDeCuenta;
    c.llavesDeCuenta = async (id) => ({ ...(await originalLlaves(id)), api_key_openai: null });
    const up2 = await llamarCtrl(ctrl.subirArchivo, { id: col.id }, archivo);
    c.llavesDeCuenta = originalLlaves;
    ok('subir sin llave de OpenAI → solo_claude (local_)', up2.ok && up2.body?.success && up2.body?.solo_claude === true && /^local_/.test(up2.body?.file_id || ''), `${up2.ok ? up2.body.file_id : up2.err?.message}`);
    const bloque2 = await d.bloqueDocumentosClaude(col.id);
    ok('Claude lo lee igual', bloque2.bloque.includes(CLAVE));
    const lista2 = await llamarCtrl(ctrl.obtenerAsistente, { id: col.id });
    const enLista2 = (lista2.body?.data?.archivos || []).find((a) => a.id === up2.body?.file_id);
    ok('aparece en la lista como local', Boolean(enLista2) && enLista2.solo_claude === true && enLista2.leido_claude === true);
    const del2 = await llamarCtrl(ctrl.eliminarArchivo, { id: col.id, file_id: up2.body?.file_id });
    const bloque3 = await d.bloqueDocumentosClaude(col.id);
    ok('borrar el local', del2.ok && del2.body?.success === true && !bloque3.bloque.includes(CLAVE));
    c.llavesDeCuenta = async (id) => ({ ...(await originalLlaves(id)), api_key_openai: null });
    const pptx = await llamarCtrl(ctrl.subirArchivo, { id: col.id }, { originalname: 'x.pptx', mimetype: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', buffer: Buffer.from('zip'), size: 3 });
    c.llavesDeCuenta = originalLlaves;
    ok('PPTX sin llave de OpenAI se rechaza con aviso', !pptx.ok && /No se pudo leer el texto/.test(String(pptx.err?.message)), String(pptx.err?.message || pptx.body?.file_id).slice(0, 90));
  } else {
    console.log('  · requiere columna válida y cuenta con Claude');
  }
  console.log(`\n  tokens Claude gastados en [6]: ${costoTokens}`);
}

(async () => {
  await enSeco();
  if (REAL) await enReal();
  else console.log('\n(sin --real: no se llamó a la API)');
  console.log(`\n${pasan} pasan, ${fallan} fallan`);
  process.exit(fallan ? 1 : 0);
})().catch((e) => {
  console.error('ERROR', e?.status || '', e.message);
  process.exit(1);
});
