// scripts/bateria_regresion.js
// ─────────────────────────────────────────────────────────────
// La batería que se corre ANTES de cada deploy que toque el motor del bot
// (contextoColumna, buscar_producto_referral, fileSearch, kanban_ia).
//
//   node scripts/bateria_regresion.js          → Suite A: determinista, gratis,
//                                                segundos. Sin OpenAI.
//   node scripts/bateria_regresion.js --full   → Suite A + Suite B: conversaciones
//                                                completas contra los asistentes
//                                                reales (simular_conversacion),
//                                                con aserciones automáticas.
//                                                Cuesta tokens y tarda minutos.
//
// Sale con código 1 si algo falla: sirve de candado en un hook o a mano.
//
// CADA CASO ES UN INCIDENTE REAL. No borrar casos "porque ya no fallan":
// existen para que no vuelvan a fallar.
//   - "Está bien"/"Estas"/"Quito" → caso 285 del 2026-08-17: una muletilla
//     matcheó "Desde ESTA Noche" y el bot cambió de producto al cierre.
//   - cabeza/cabezal → caso 285: prefijo tratado como plural.
//   - ancla vieja → regresión cazada con dropi_combo: el anuncio ganaba para
//     siempre y arrastraba al bot de vuelta tras un cambio legítimo.
//   - bot-se-equivoca-solo → caso cabezal: la fuente-bot sin validación
//     clava el propio error del bot.
// ─────────────────────────────────────────────────────────────

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { execFileSync } = require('child_process');
const path = require('path');

const FULL = process.argv.includes('--full');

// Config de dropshipping usada como banco de pruebas (catálogo real, >40
// ítems, con el par máscara/antironquidos del incidente). El contacto es el
// número de pruebas del equipo en esa cuenta.
const CFG_DROPI = 285;
const CLIENTE_DROPI = 297780;
const AD_MASCARA = '120245590876310773';
// Config de servicios (inmobiliaria) y su contacto de pruebas.
const CFG_SERVICIOS = 818;
const CLIENTE_SERVICIOS = 566217;

const resultados = [];
const caso = (nombre, ok, detalle = '') => {
  resultados.push({ nombre, ok, detalle });
  console.log(`  ${ok ? '✅' : '❌'} ${nombre}${detalle && !ok ? ` — ${detalle}` : ''}`);
};

/* Historial sintético: la conversación del incidente, más nuevo primero.
   Se pasa por opts.historial para que el caso no dependa del estado real del
   contacto en la BD (otros tests pueden haberlo movido). */
const HISTORIAL_MASCARA = (ultimo) => [
  { rol_mensaje: 0, texto_mensaje: ultimo },
  { rol_mensaje: 1, texto_mensaje: 'El Combo 1 de la Mascara Tactica Multi Funcional incluye 2 unidades por $29.99' },
  { rol_mensaje: 0, texto_mensaje: 'Combo 1' },
  { rol_mensaje: 1, texto_mensaje: 'La Mascara Tactica Multi Funcional cuesta $21.99' },
  { rol_mensaje: 0, texto_mensaje: 'Hola, vi el anuncio de la Máscara Táctica Multifuncional y quiero más información' },
];

async function suiteA() {
  console.log('\n══ SUITE A · determinista (sin OpenAI) ══\n');

  // 1. La lista medida de palabras existe y trae lo esencial.
  try {
    const lista = require('../src/utils/palabrasFrecuentesChat.json');
    caso('palabrasFrecuentesChat.json existe', Array.isArray(lista) && lista.length > 20, `largo=${lista.length}`);
    caso('la lista trae "esta" (el caso 285)', lista.includes('esta'));
    caso('la lista trae "quito" (ciudad como respuesta suelta)', lista.includes('quito'));
  } catch (e) {
    caso('palabrasFrecuentesChat.json existe', false, e.message);
  }

  const { construirContextoColumna } = require('../src/utils/contextoColumna');
  const acciones = [{ tipo_accion: 'contexto_productos', config: null }];
  const ctx = (mensaje, historial) =>
    construirContextoColumna(CFG_DROPI, acciones, () => {}, {
      mensaje,
      id_cliente: CLIENTE_DROPI,
      historial,
    });

  // 2. Muletillas y respuestas sueltas NO nombran producto ni lo cambian.
  for (const msg of ['Está bien', 'Estas', 'Quito', 'Precio', 'si esta bueno lo llevo']) {
    const b = await ctx(msg, HISTORIAL_MASCARA(msg));
    caso(
      `"${msg}" no arrastra otro producto y mantiene el ancla`,
      !/Roncar/i.test(b) && /Mascara Tactica/i.test(b),
      /Roncar/i.test(b) ? 'inyectó el antironquidos' : 'perdió el ancla de la máscara',
    );
    caso(
      `"${msg}" no repite las líneas de media (📷/🎥)`,
      !b.includes('📷') && !b.includes('MÁNDALE'),
      'media en turno sin producto nombrado → el modelo lo lee como adjuntos',
    );
  }

  // 3. Una mención legítima SÍ trae ficha completa con media, sin soltar el ancla.
  {
    const b = await ctx('quiero la licuadora', HISTORIAL_MASCARA('quiero la licuadora'));
    caso(
      'mención legítima trae ficha + media del nombrado',
      /Licuadora/i.test(b) && b.includes('📷'),
    );
    caso('y el ancla de la conversación sigue presente', /Mascara Tactica/i.test(b));
  }

  // 4. cabeza ≠ cabezal (prefijo no es plural).
  {
    const b = await ctx('sirve para la cabeza del bebe?', HISTORIAL_MASCARA('sirve para la cabeza del bebe?'));
    caso('"cabeza" no trae el Cabezal de ducha', !/Cabezal de ducha/i.test(b));
  }

  // 5. Ancla por recencia: el cambio pedido por el cliente mueve el ancla…
  {
    const b = await ctx('y si llevo 2?', [
      { rol_mensaje: 0, texto_mensaje: 'y si llevo 2?' },
      { rol_mensaje: 1, texto_mensaje: 'La Rodillera Ortopedica cuesta $24.99. Combos: 2 x $29.99' },
      { rol_mensaje: 0, texto_mensaje: 'cuanto cuesta la rodillera?' },
      { rol_mensaje: 1, texto_mensaje: 'La Mascara Tactica Multi Funcional cuesta $21.99' },
      { rol_mensaje: 0, texto_mensaje: 'Hola, vi el anuncio de la Máscara Táctica Multifuncional' },
    ]);
    caso(
      'cambio pedido por el cliente mueve el ancla (rodillera)',
      /PRODUCTO DE ESTA CONVERSACIÓN: Rodillera/i.test(b),
    );
  }

  // 6. …pero un error del bot solo NO la mueve (validación anti-cabezal).
  {
    const b = await ctx('Quiero las mascarillas', [
      { rol_mensaje: 0, texto_mensaje: 'Quiero las mascarillas' },
      { rol_mensaje: 1, texto_mensaje: 'El producto Deja de Roncar Desde Esta Noche Antironquidos cuesta $24.00' },
      { rol_mensaje: 0, texto_mensaje: 'Está bien' },
      { rol_mensaje: 1, texto_mensaje: 'La Mascara Tactica Multi Funcional cuesta $21.99' },
      { rol_mensaje: 0, texto_mensaje: 'Hola, vi el anuncio de la Máscara Táctica Multifuncional' },
    ]);
    caso(
      'un error del bot no ancla su propio error (se autocorrige)',
      /PRODUCTO DE ESTA CONVERSACIÓN: Mascara/i.test(b) && !/PRODUCTO DE ESTA CONVERSACIÓN: Deja de Roncar/i.test(b),
    );
  }

  // 7. El resolver de anuncios responde por el mapa (nivel determinista).
  {
    const { resolverProductoAnuncio } = require('../src/utils/webhook_whatsapp/buscar_producto_referral');
    const r = await resolverProductoAnuncio(CFG_DROPI, 'Mascara Tactica Multi Funcional', AD_MASCARA);
    caso(
      'anuncio conocido resuelve por el mapa (via=mapa)',
      r?.via === 'mapa' && /Mascara/i.test(r?.producto?.nombre || ''),
      `via=${r?.via} producto=${r?.producto?.nombre}`,
    );
  }
}

/* Suite B: conversaciones completas contra los asistentes reales.
   Cada guion corre simular_conversacion.js (solo lectura, hilo desechable) y
   se revisa el texto del bot con reglas simples: qué NO puede aparecer y qué
   SÍ tiene que aparecer. Las palabras prohibidas son la red gruesa: el bot
   redacta distinto cada vez, pero nombrar el producto equivocado siempre es
   nombrar el producto equivocado. */
/* --desde fija la columna de arranque: sin eso el guion depende de dónde quedó
   el contacto la última vez (un asesor que se asigna el chat de pruebas deja
   al contacto en "asesor", sin IA, y toda la suite muere en el turno 1). */
const GUIONES_B = [
  {
    nombre: 'incidente 285: anuncio → cierre sin cambiar de producto',
    args: [String(CFG_DROPI), String(CLIENTE_DROPI), '--desde=contacto_inicial',
      'Hola, vi el anuncio de la Máscara Táctica Multifuncional y quiero más información',
      'Precio', 'Combo 1', 'Está bien', 'Quito'],
    prohibido: /roncar|antironquido/i,
    requerido: /m[aá]scara/i,
  },
  {
    nombre: 'dropshipping: combos y cambio de producto pedido',
    args: [String(CFG_DROPI), String(CLIENTE_DROPI), '--desde=contacto_inicial', '--guion=dropi_combo'],
    prohibido: /roncar|antironquido|m[aá]scara t[aá]ctica/i,
    requerido: /rodillera/i,
  },
  {
    nombre: 'cambio explícito: máscara → licuadora',
    args: [String(CFG_DROPI), String(CLIENTE_DROPI), '--desde=contacto_inicial',
      'Hola, vi el anuncio de la Máscara Táctica Multifuncional',
      'mejor quiero la licuadora', 'y si llevo 2?'],
    prohibido: /roncar|antironquido/i,
    requerido: /licuadora/i,
  },
  {
    nombre: 'servicios 818: agendamiento no se rompe',
    args: [String(CFG_SERVICIOS), String(CLIENTE_SERVICIOS), '--desde=captacion', '--guion=laser'],
    prohibido: /error|exception/i,
    requerido: /cita|agend/i,
  },
];

function suiteB() {
  console.log('\n══ SUITE B · conversaciones reales simuladas (--full) ══\n');
  for (const g of GUIONES_B) {
    let salida = '';
    try {
      salida = execFileSync(
        process.execPath,
        [path.join(__dirname, 'simular_conversacion.js'), ...g.args],
        { encoding: 'utf8', timeout: 8 * 60 * 1000 },
      );
    } catch (e) {
      caso(g.nombre, false, `el simulador falló: ${e.message}`);
      continue;
    }
    // Solo lo que dijo el bot (líneas de mensaje), no los guiones del cliente.
    const delBot = salida
      .split('\n')
      .filter((l) => /^\s+\d+│|^\s+│/.test(l))
      .join('\n');
    const malas = g.prohibido.test(delBot);
    const buenas = g.requerido.test(delBot);
    caso(
      g.nombre,
      !malas && buenas,
      malas ? `apareció lo prohibido (${g.prohibido})` : `no apareció lo requerido (${g.requerido})`,
    );
    const fallas = /⚠️\s+(.+)/g;
    let m;
    while ((m = fallas.exec(salida))) console.log(`     · aviso del simulador: ${m[1]}`);
  }
}

(async () => {
  await suiteA();
  if (FULL) suiteB();
  else console.log('\n(Suite B no corrió: agregá --full para las conversaciones completas)');

  const malos = resultados.filter((r) => !r.ok);
  console.log(`\n══ RESULTADO: ${resultados.length - malos.length}/${resultados.length} en verde ══`);
  if (malos.length) {
    console.log('FALLARON:');
    malos.forEach((r) => console.log(`  ❌ ${r.nombre}${r.detalle ? ` — ${r.detalle}` : ''}`));
    process.exit(1);
  }
  process.exit(0);
})().catch((e) => {
  console.error('ERROR de la batería:', e.stack);
  process.exit(1);
});
