/* Arnés del bot de soporte IMPORSHOP PROVEEDOR (prompt_soporte_imporshop).

   Corre los escenarios del brief de Evelyn + casos reales de la cfg 261 por el
   MISMO camino que producción (contexto de columna, Responses API, sanitizador,
   extracción de media, limpieza de tags/coletillas/markdown), con el prompt
   armado desde el módulo y sin tocar ninguna columna. Gasta la api key de la
   cfg 10 (pruebas), no la del cliente.

   Uso: node scripts/arnes_soporte_imporshop.js [escenario] [modelo]  */
require('dotenv').config();
const { db } = require('../src/database/config');
const {
  ejecutarConResponsesAPI,
  limpiarTagsAcciones,
} = require('../src/services/kanban_ia.service');
const { construirContextoColumna } = require('../src/utils/contextoColumna');
const { sanitizarRespuestaAgente } = require('../src/utils/openia/sanitizador_agente');
const { extraerUrlsMedia } = require('../src/utils/urlsMedia');
const { limpiarColetillas } = require('../src/utils/limpiarColetillas');
const { limpiarMarkdown } = require('../src/utils/formatoWhatsapp');
const { leerApiKeyOpenAI } = require('../src/utils/openia/apiKeyOpenAI');
const { promptSoporteImporshop } = require('../src/utils/prompt_soporte_imporshop.data');

const SOLO = process.argv[2] && process.argv[2] !== 'todos' ? process.argv[2] : null;
const MODELO = process.argv[3] || 'gpt-4o';

// URLs ficticias: aquí solo importa que el bot ponga la etiqueta correcta.
const MEDIA = {
  video_material: 'https://media.test/imporshop_material.mp4',
  video_estado_guia: 'https://media.test/imporshop_estado_guia.mp4',
  video_retener: 'https://media.test/imporshop_retener_guia.mp4',
  video_novedades: 'https://media.test/imporshop_novedades.mp4',
  imagen_horarios: 'https://media.test/horarios_corte_imporshop.png',
};
const V = {
  material: /imporshop_material\.mp4/,
  guia: /imporshop_estado_guia\.mp4/,
  retener: /imporshop_retener_guia\.mp4/,
  novedades: /imporshop_novedades\.mp4/,
  horarios: /horarios_corte_imporshop\.png/,
};
const SALUDO = /¡?hola!?\s*¿?c[oó]mo est[aá]s/i;
const ASESOR = '[asesor]:true';
const RESUELTO = '[resuelto]:true';
const AUDIO_ILEGIBLE = '[El cliente envió un audio que no se pudo transcribir]';

/* Cada turno queda como { crudo, texto, medias, tags }. `texto` es lo que lee
   el cliente; `medias` lo que sale como adjunto. */
const ESCENARIOS = [
  {
    nombre: 'saludo_y_luego_fotos',
    mensajes: ['hola', 'necesito fotos del ID 186860'],
    checks: ([t1, t2]) => [
      !SALUDO.test(t1.texto) && 'turno 1 sin saludo',
      t1.medias.length && 'turno 1 mandó media a un saludo',
      SALUDO.test(t2.texto) && 'turno 2 volvió a saludar',
      !V.material.test(t2.medias.join()) && 'turno 2 sin video MATERIAL',
      !/catalogo-imporshop-comunidad/.test(t2.texto) && 'turno 2 sin link del catálogo',
    ],
  },
  {
    nombre: 'corte_sabado',
    mensajes: ['a qué hora es el corte el sábado'],
    checks: ([t]) => [
      !V.horarios.test(t.medias.join()) && 'sin imagen de horarios',
      !/8:00/.test(t.texto) && 'no dio el corte de sábado (8:00)',
      t.tags.length && `puso tag ${t.tags}`,
    ],
  },
  {
    nombre: 'guia_no_sale',
    mensajes: ['guía 189852073 no sale desde el 25', 'sigue pendiente'],
    checks: ([t1, t2]) => [
      !V.guia.test(t1.medias.join()) && 'sin video ESTADO DE GUÍA',
      !/track\?guia=189852073/.test(t1.texto) && 'link de rastreo sin el número de guía',
      t1.tags.length && `turno 1 puso tag ${t1.tags}`,
      !t2.tags.includes(ASESOR) && 'turno 2 no pasó a asesor',
      /n[uú]mero de gu[ií]a\s*\?|p[aá]same|env[ií]a(me|nos) (el|los) n[uú]mero/i.test(t2.texto) &&
        'volvió a pedir la guía que ya dio',
    ],
  },
  {
    nombre: 'varias_guias',
    mensajes: ['buenas, estas guías no tienen movimiento V4003166071 y V4003166072'],
    checks: ([t]) => [
      !/track\?guia=V4003166071/.test(t.texto) && 'falta link de la 1ª guía',
      !/track\?guia=V4003166072/.test(t.texto) && 'falta link de la 2ª guía',
    ],
  },
  {
    nombre: 'retener',
    mensajes: ['quiero retener una guía', 'no entiendo'],
    checks: ([t1, t2]) => [
      !V.retener.test(t1.medias.join()) && 'sin video RETENER',
      !/imporchina\.com\/r\/retener/.test(t1.texto) && 'sin link de retener',
      !/48 horas/.test(t1.texto) && 'sin aviso de 48 horas',
      !t2.tags.includes(ASESOR) && '"no entiendo" no pasó a asesor',
    ],
  },
  {
    nombre: 'incompleto',
    mensajes: ['llegó incompleto el pedido de mi cliente'],
    checks: ([t]) => [
      !t.tags.includes(ASESOR) && 'garantía no pasó a asesor en el mismo mensaje',
      !/n[uú]mero de gu[ií]a/i.test(t.texto) && 'no pidió número de guía',
      /\bs[ií] aplica|no aplica/i.test(t.texto) && 'opinó si la garantía aplica',
    ],
  },
  {
    nombre: 'stock_sin_id',
    mensajes: ['tienen stock de camisa compresión', 'es el 145233'],
    checks: ([t1, t2]) => [
      t1.tags.length && `turno 1 puso tag ${t1.tags} (debía pedir ID)`,
      !/\bID\b/i.test(t1.texto) && 'no pidió el ID',
      /\d+\s*(unidades|disponibles)/i.test(t1.texto + t2.texto) && 'dio números de stock',
      !t2.tags.includes(ASESOR) && 'con el ID no pasó a asesor',
    ],
  },
  {
    nombre: 'stock_con_id',
    mensajes: ['hola, hay stock del 62043 freidora con canasta?'],
    checks: ([t]) => [
      !t.tags.includes(ASESOR) && 'trajo el ID y no pasó directo a asesor',
      /ayúdame por favor con:\s*\n?\s*1\. El ID/i.test(t.texto) && 'volvió a pedir el ID',
    ],
  },
  {
    nombre: 'audio_ilegible',
    mensajes: [AUDIO_ILEGIBLE],
    checks: ([t]) => [!t.tags.includes(ASESOR) && 'audio ilegible no pasó a asesor'],
  },
  {
    nombre: 'gracias_cierra',
    mensajes: ['me pasas el material del ID 186860', 'gracias'],
    checks: ([t1, t2]) => [
      !V.material.test(t1.medias.join()) && 'sin video MATERIAL',
      !t2.tags.includes(RESUELTO) && '"gracias" no marcó resuelto',
    ],
  },
  {
    nombre: 'novedad',
    mensajes: ['mi pedido está en novedad, el cliente no contesta'],
    checks: ([t]) => [
      !V.novedades.test(t.medias.join()) && 'sin video NOVEDADES',
      t.tags.includes(ASESOR) && 'novedad pasó a asesor de entrada',
    ],
  },
  {
    nombre: 'alumno_imporfactory',
    mensajes: ['soy alumno de imporfactory y no puedo vincular mi whatsapp a imporchat'],
    checks: ([t]) => [
      !/wa\.link\/821bny/.test(t.texto) && 'sin el link de alumnos',
      t.tags.includes(ASESOR) && 'alumno pasó a asesor (debía redirigir)',
    ],
  },
  {
    nombre: 'descuento_mayor',
    mensajes: ['si te llevo 50 del 62043 me los dejas en $4,50?'],
    checks: ([t]) => [
      !t.tags.includes(ASESOR) && 'mayorista no pasó a asesor',
      /\$\s?\d/.test(t.texto) && 'mencionó un precio',
    ],
  },
  {
    nombre: 'molesto',
    mensajes: ['Su equipo de soporte no esta haciendo bien las cosas, ayer solo me escribieron 1 mensaje y nadie me responde'],
    checks: ([t]) => [!t.tags.includes(ASESOR) && 'cliente molesto no pasó a asesor'],
  },
  {
    nombre: 'pagos',
    mensajes: ['Banco Pichincha cuenta de ahorros a nombre de Luis Llerena #2204516087, para que me devuelvan lo del wallet'],
    checks: ([t]) => [
      !t.tags.includes(ASESOR) && 'pagos no pasó a asesor',
      /comprobante/i.test(t.texto) && 'pidió comprobante',
    ],
  },
  {
    nombre: 'nuevo_mexico',
    mensajes: ['hola soy de méxico, quiero empezar a vender sus productos, cómo hago?'],
    checks: ([t]) => [
      !/dropi\.mx\/imporfactory/.test(t.texto) && 'sin link de Dropi México',
      /dropi\.ec/.test(t.texto) && 'mandó el link de Ecuador a un mexicano',
      /si tienes alguna duda, un asesor te acompa/i.test(t.texto) === false &&
        'se perdió "Si tienes alguna duda, un asesor te acompaña"',
    ],
  },
  {
    nombre: 'dos_temas',
    mensajes: ['buenas tardes, necesito videos de la secadora de ropa y saber a qué hora es el corte de servientrega'],
    checks: ([t]) => [
      !V.material.test(t.medias.join()) && 'sin video MATERIAL',
      !V.horarios.test(t.medias.join()) && 'sin imagen de horarios',
    ],
  },
  {
    nombre: 'talla_no_en_dropi',
    mensajes: ['en dropi no hay la talla 3xl del conjunto deportivo, como la solicito?'],
    checks: ([t]) => [
      /\d+\s*(unidades|disponibles)/i.test(t.texto) && 'dio números de stock',
    ],
  },
];

function checksGlobales(turnos) {
  const e = [];
  turnos.forEach((t, i) => {
    if (i > 0 && SALUDO.test(t.texto)) e.push(`turno ${i + 1} volvió a saludar`);
    if (t.tags.length > 1) e.push(`turno ${i + 1} con ${t.tags.length} tags`);
    if (/\*\*|^#{1,6}\s/m.test(t.crudo)) e.push(`turno ${i + 1} escribió markdown`);
    if (/drive\.google/.test(t.crudo)) e.push(`turno ${i + 1} pegó link de Drive`);
    if (/\[[a-z_]+\]:\s*true/i.test(t.texto)) e.push(`turno ${i + 1}: tag visible para el cliente`);
    if (/producto_(video|imagen)_url/.test(t.texto)) e.push(`turno ${i + 1}: etiqueta de media visible`);
    if (/te paso con (un )?asesor|asesor revisa tu caso/i.test(t.texto) && !t.tags.includes(ASESOR))
      e.push(`turno ${i + 1} promete asesor sin [asesor]:true`);
    // El motor detecta el tag en cualquier lugar (includes); lo que importa es
    // que el texto le diga al cliente qué pasa.
    if (t.tags.includes(ASESOR) && !/asesor revisa tu caso/i.test(t.texto))
      e.push(`turno ${i + 1}: pasó a asesor sin el mensaje de paso a humano`);
    if (t.tags.includes(RESUELTO) && !/con gusto/i.test(t.texto))
      e.push(`turno ${i + 1}: marcó resuelto sin ser el cierre`);
  });
  return e;
}

(async () => {
  const [c10] = await db.query(
    `SELECT api_key_openai FROM configuraciones WHERE id = 10`,
    { type: db.QueryTypes.SELECT },
  );
  const api_key_openai = leerApiKeyOpenAI(c10?.api_key_openai);
  if (!api_key_openai) throw new Error('cfg 10 sin api key');

  // Acciones reales de la columna 317 (Contacto Inicial de la 261): definen el
  // contexto que se inyecta en producción.
  const acciones = await db.query(
    `SELECT tipo_accion, config, orden FROM kanban_acciones
      WHERE id_kanban_columna = 317 AND activo = 1 ORDER BY orden`,
    { type: db.QueryTypes.SELECT },
  );
  const instructions = promptSoporteImporshop(MEDIA);
  console.log(`modelo ${MODELO} · prompt ${instructions.length} chars\n`);

  let fallasTotal = 0;
  let tokIn = 0;
  let tokOut = 0;
  for (const esc of ESCENARIOS) {
    if (SOLO && esc.nombre !== SOLO) continue;
    process.stdout.write(`▶ ${esc.nombre} `);
    const turnos = [];
    const historial = [];
    let prev = null;
    try {
      for (const mensaje of esc.mensajes) {
        const contexto = await construirContextoColumna(261, acciones, null, {
          mensaje,
          id_cliente: 0,
          historial: [{ rol_mensaje: 0, texto_mensaje: mensaje }, ...historial],
        });
        const input = String(contexto || '').trim()
          ? `🧾 Contexto adicional:\n\n${contexto.trim()}\n\n💬 MENSAJE ACTUAL DEL CLIENTE (responde a ESTO):\n${mensaje}`
          : mensaje;
        const r = await ejecutarConResponsesAPI({
          previous_response_id: prev,
          instructions,
          additional_instructions: null,
          input,
          model: MODELO,
          max_tokens: 1200,
          vector_store_id: null,
          api_key_openai,
          id_configuracion: 10,
        });
        prev = r.response_id || prev;
        tokIn += r.usage?.input_tokens || r.total_tokens || 0;
        tokOut += r.usage?.output_tokens || 0;
        const crudo = sanitizarRespuestaAgente(r.respuesta || '');
        const tags = [ASESOR, RESUELTO].filter((tg) => crudo.toLowerCase().includes(tg));
        const media = extraerUrlsMedia(crudo);
        const texto = limpiarMarkdown(limpiarColetillas(limpiarTagsAcciones(media.texto).trim()));
        turnos.push({
          crudo,
          texto,
          tags,
          medias: [...media.imagenes, ...media.videos],
        });
        historial.unshift({ rol_mensaje: 0, texto_mensaje: mensaje });
        historial.unshift({ rol_mensaje: 1, texto_mensaje: texto });
        process.stdout.write('.');
      }
    } catch (err) {
      console.log(` ✖ error: ${err.response?.data?.error?.message || err.message}`);
      fallasTotal += 1;
      continue;
    }

    const fallas = [...esc.checks(turnos), ...checksGlobales(turnos)].filter(Boolean);
    console.log(fallas.length ? ` ✖ ${fallas.length}` : ' ✔');
    for (const f of fallas) console.log(`     - ${f}`);
    fallasTotal += fallas.length;
    if (fallas.length || SOLO) {
      turnos.forEach((t, i) => {
        console.log(`   [cliente] ${esc.mensajes[i]}`);
        if (t.medias.length) console.log(`   [media] ${t.medias.map((m) => m.split('/').pop()).join(', ')}`);
        console.log(`   [bot${t.tags.length ? ' ' + t.tags.join(' ') : ''}] ${t.texto.replace(/\n/g, '\n         ')}`);
      });
    }
  }
  console.log(`\n📊 tokens: ${tokIn} entrada + ${tokOut} salida`);
  console.log(fallasTotal ? `❌ ${fallasTotal} fallas` : '✅ TODOS LOS ESCENARIOS PASAN');
  await db.close();
  process.exit(fallasTotal ? 1 : 0);
})().catch((e) => {
  console.error('ERROR:', e.message);
  process.exit(1);
});
