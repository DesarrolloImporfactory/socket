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
      // Etiquetas con url, no el aviso "su foto YA se le envió" (que también
      // usa el emoji): lo peligroso es la url suelta en un turno sin producto.
      !b.includes('📷 imagen:') && !b.includes('🎥 video:') && !b.includes('MÁNDALE'),
      'media en turno sin producto nombrado → el modelo lo lee como adjuntos',
    );
  }

  // 3. Una mención legítima SÍ trae ficha completa con media, sin soltar el ancla.
  {
    const b = await ctx('quiero la licuadora', HISTORIAL_MASCARA('quiero la licuadora'));
    caso(
      'mención legítima trae ficha + media del nombrado',
      /Licuadora/i.test(b) && b.includes('📷 imagen:'),
    );
    caso('y el ancla de la conversación sigue presente', /Mascara Tactica/i.test(b));
  }

  // 4. cabeza ≠ cabezal (prefijo no es plural).
  {
    const b = await ctx('sirve para la cabeza del bebe?', HISTORIAL_MASCARA('sirve para la cabeza del bebe?'));
    caso('"cabeza" no trae el Cabezal de ducha', !/Cabezal de ducha/i.test(b));
  }

  // 5. Ancla por recencia: el cambio pedido por el cliente mueve el ancla…
  //    El producto se toma EN VIVO del catálogo de la 285: antes era la
  //    "Rodillera Ortopedica" quemada, el cliente la borró de su catálogo y el
  //    caso quedó en rojo sin que hubiera ninguna regresión de código.
  {
    const { db } = require('../src/database/config');
    const [otro] = await db.query(
      `SELECT nombre FROM productos_chat_center
        WHERE id_configuracion = ? AND eliminado = 0
          AND nombre NOT LIKE '%Mascara%' AND nombre NOT LIKE '%Cabezal%'
          AND CHAR_LENGTH(nombre) BETWEEN 8 AND 60
        ORDER BY id LIMIT 1`,
      { replacements: [CFG_DROPI], type: db.QueryTypes.SELECT },
    );
    const nombre = otro?.nombre || 'Rodillera Ortopedica';
    const primera = nombre.split(/\s+/)[0];
    const b = await ctx('y si llevo 2?', [
      { rol_mensaje: 0, texto_mensaje: 'y si llevo 2?' },
      { rol_mensaje: 1, texto_mensaje: `La ${nombre} cuesta $24.99. Combos: 2 x $29.99` },
      { rol_mensaje: 0, texto_mensaje: `cuanto cuesta la ${nombre}?` },
      { rol_mensaje: 1, texto_mensaje: 'La Mascara Tactica Multi Funcional cuesta $21.99' },
      { rol_mensaje: 0, texto_mensaje: 'Hola, vi el anuncio de la Máscara Táctica Multifuncional' },
    ]);
    const esc = primera.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    caso(
      `cambio pedido por el cliente mueve el ancla (${primera})`,
      new RegExp(`PRODUCTO DE ESTA CONVERSACIÓN:[^\\n]*${esc}`, 'i').test(b),
      `producto vivo usado: ${nombre}`,
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

  // 8. Caso "foto del casco" (285, 2026-08-17): el cliente preguntó
  //    "¿protege la cabeza?" y file_search le pasó al modelo el fragmento del
  //    "Intercomunicador Bluetooth para CASCO" con su URL de imagen adentro —
  //    mandó esa foto hablando de la máscara. Dos garantías lo matan:
  {
    const { db } = require('../src/database/config');
    const {
      catalogoInlineActivo,
      TOPE_CATALOGO_INLINE,
    } = require('../src/utils/openia/fileSearch');

    // a) La 285 tiene que caber en inline (ahí el doc no se trocea).
    const [col] = await db.query(
      `SELECT catalogo_inline_tokens AS t FROM kanban_columnas
        WHERE id_configuracion = ? AND activo = 1 AND activa_ia = 1
          AND catalogo_inline_tokens IS NOT NULL LIMIT 1`,
      { replacements: [CFG_DROPI], type: db.QueryTypes.SELECT },
    );
    caso(
      `la ${CFG_DROPI} entra al catálogo inline (tokens ≤ ${TOPE_CATALOGO_INLINE})`,
      !!col && catalogoInlineActivo(CFG_DROPI, col.t),
      `tokens=${col?.t}`,
    );

    // b) El doc de file_search sale SIN URLs de media, para las que no caben.
    const {
      sinMediaParaFileSearch,
    } = require('../src/services/syncCatalogoKanbanColumna.service');
    const doc = sinMediaParaFileSearch({
      items: [
        {
          nombre: 'Intercomunicador',
          producto_imagen_url: 'https://x/foto.png',
          producto_video_url: 'https://x/video.mp4',
          bloque_prompt:
            '🛒 Producto: Intercomunicador\n[producto_imagen_url]: https://x/foto.png\n[producto_video_url]: https://x/video.mp4\nPrecio: 29.99',
        },
      ],
      instrucciones_uso_ia: ['Use los identificadores [producto_imagen_url], [producto_video_url] cuando existan.'],
    });
    const texto = JSON.stringify(doc);
    caso(
      'el doc de file_search sale sin URLs de imagen/video',
      !texto.includes('foto.png') && !texto.includes('video.mp4') &&
        /NO escriba URLs/.test(texto),
    );

    // c) Y la raíz: aunque una URL ajena llegue al modelo por donde sea, el
    //    candado de propiedad (dedupeMedia) no la deja salir al cliente.
    const { esMediaPermitida } = require('../src/utils/dedupeMedia');
    const CASCO =
      'https://chat.imporfactory.app/uploads/productos/imagen/1dd4a79b-83dc-4923-9746-d0ac289075f6.png';
    const MASCARA =
      'https://chat.imporfactory.app/uploads/productos/imagen/43197ba2-8462-449d-a748-b5c91e646895.jpg';
    caso(
      'la foto de un producto ajeno a la conversación se bloquea al enviar',
      (await esMediaPermitida({ id_configuracion: CFG_DROPI, id_cliente: CLIENTE_DROPI, url: CASCO })) === false,
    );
    caso(
      'la foto del producto de la conversación sí sale',
      (await esMediaPermitida({ id_configuracion: CFG_DROPI, id_cliente: CLIENTE_DROPI, url: MASCARA })) === true,
    );
    caso(
      'media que no es de catálogo no se toca',
      (await esMediaPermitida({ id_configuracion: CFG_DROPI, id_cliente: CLIENTE_DROPI, url: 'https://chat.imporfactory.app/uploads/documentos/manual.pdf' })) === true,
    );
  }

  // 9. Caso Vinicio (285, 2026-08-17): "Si el combo de tres" sin dar ni un
  //    dato → el modelo copió la plantilla del prompt ("Nombre: *[nombre
  //    completo real]*"), cerró la venta y movió el contacto a generar_guia.
  //    Un cierre con placeholders NO puede contar como venta.
  {
    const { motivoCierreInvalido } = require('../src/services/kanban_ia.service');
    const basura =
      'Listo! Aquí tienes el resumen:\n' +
      '🧑 Nombre: *[nombre completo real]*\n📞 Telefono: *[teléfono real y completo]*\n' +
      '📍 Provincia: *[provincia de la ciudad]*\n📦 Producto: *Evil Goods*\n' +
      '🔢 Cantidad: *3*\n[generar_guia]:true';
    const valido =
      'Tu pedido queda así:\n🧑 Nombre: Marcos Vinicio Torres\n📞 Telefono: 0979462998\n' +
      '📍 Provincia: Manabí\n📍 Ciudad: Calceta\n🏡 Dirección: Bolívar y El Limón, junto a la ESPAM\n' +
      '📦 Producto: Evil Goods\n🔢 Cantidad: 3\n💰 Precio total: $45.00\n' +
      '[producto_imagen_url]: https://x/foto.jpg\n[generar_guia]:true';
    caso(
      'cierre con placeholders se bloquea (caso Vinicio)',
      motivoCierreInvalido(basura) !== null,
      `motivo=${motivoCierreInvalido(basura)}`,
    );
    caso(
      'cierre con datos reales pasa (tags y media no confunden)',
      motivoCierreInvalido(valido) === null,
      `motivo=${motivoCierreInvalido(valido)}`,
    );

    // Caso 569 del 2026-08-18: el modelo nunca pidió el celular y cerró con
    // "📞 Teléfono: 09XXXXXXXX (a confirmar)" — sin corchetes ni "(pendiente)",
    // así que el candado de arriba no lo veía y el pedido entraba sin teléfono.
    const telEnmascarado =
      'Aquí está el resumen:\n🧑 Nombre: Michael Orodnez\n' +
      '📞 Teléfono: 09XXXXXXXX (a confirmar)\n📍 Provincia: Azuay\n' +
      '📍 Ciudad: Cuenca\n🏡 Dirección: Alfredo Borja y Rumipamba, frente a un Tuti\n' +
      '📦 Producto: Shampoo Cubre Canas IVSI 400gr\n🔢 Cantidad: 1\n' +
      '💰 Precio total: $22.99\n🚚 Envío: domicilio\n[generar_guia]:true';
    caso(
      'cierre con teléfono enmascarado se bloquea (caso 569)',
      motivoCierreInvalido(telEnmascarado) !== null,
      `motivo=${motivoCierreInvalido(telEnmascarado)}`,
    );
    caso(
      'cierre con nombre de una sola palabra se bloquea',
      motivoCierreInvalido(valido.replace('Marcos Vinicio Torres', 'Marcos')) !== null,
    );
    // La agencia "por confirmar" del flujo 7.4 vive en 🏡 Direccion y es
    // legítima: la validación del teléfono es por línea justo para no
    // confundirla con relleno.
    const agenciaPorConfirmar = valido.replace(
      'Bolívar y El Limón, junto a la ESPAM',
      'Agencia Servientrega por confirmar — Calceta, sector el parque central',
    );
    caso(
      'cierre con agencia "por confirmar" en la dirección sigue pasando',
      motivoCierreInvalido(agenciaPorConfirmar) === null,
      `motivo=${motivoCierreInvalido(agenciaPorConfirmar)}`,
    );

    // Casos 285 del 2026-08-19: el candado solo validaba las líneas que
    // EXISTÍAN, y el modo de fallo real fue omitirlas o rellenarlas entre
    // paréntesis. Tres resúmenes reales que pasaron limpios ese día:

    // a) Alejandro (711657): cerró SOLO con cantidad/precio/producto — el
    //    cliente respondió "¿Si sabe a dónde enviarlo???".
    const sinNadie =
      'Listo! Pedido confirmado, pago contra entrega:\n🔢 Cantidad: 2\n' +
      '💰 Precio total: 25.00\n📦 Producto: Deja de Roncar Desde Esta Noche\n' +
      '🚚 Envío: domicilio\n[generar_guia]:true';
    caso(
      'cierre sin nombre/teléfono/ciudad/dirección se bloquea (caso Alejandro)',
      motivoCierreInvalido(sinNadie) !== null,
      `motivo=${motivoCierreInvalido(sinNadie)}`,
    );

    // b) Natalia (712423): "📍 Ciudad: (necesito que me digas la ciudad)" —
    //    relleno entre paréntesis que la blacklist de frases no veía.
    const ciudadRelleno =
      'Listo! Pedido confirmado, pago contra entrega:\n' +
      '🧑 Nombre: Natalia María Guzmán Moscoso\n📞 Telefono: 0962822713\n' +
      '📍 Ciudad: (necesito que me digas la ciudad)\n' +
      '🏦 Agencia Servientrega: (si aplica)\n📦 Producto: Evil Goods\n' +
      '🔢 Cantidad: 2\n💰 Precio total: 35.00\n🚚 Envio: domicilio\n' +
      '[generar_guia]:true';
    caso(
      'cierre con ciudad de relleno entre paréntesis se bloquea (caso Natalia)',
      motivoCierreInvalido(ciudadRelleno) !== null,
      `motivo=${motivoCierreInvalido(ciudadRelleno)}`,
    );

    // c) Solanda (712250): con nombre y teléfono pero sin líneas de ciudad ni
    //    dirección (el "1.5 km de Portoviejo" quedó dentro de Envío).
    const sinCiudadNiDir =
      '¡Gracias Solanda! 😊 Aquí tienes todos los datos:\n' +
      '🧑 Nombre: Solanda Faviola Andrade Mera\n📞 Teléfono: 0969187524\n' +
      '📦 Producto: Máscara Táctica Multifuncional\n🔢 Cantidad: 1\n' +
      '💰 Precio total: 21.99\n🚚 Envío: Domicilio a 1.5 km de Portoviejo\n' +
      '[generar_guia]:true';
    caso(
      'cierre sin líneas de ciudad y dirección se bloquea (caso Solanda)',
      motivoCierreInvalido(sinCiudadNiDir) !== null,
      `motivo=${motivoCierreInvalido(sinCiudadNiDir)}`,
    );

    // d) La línea de teléfono AUSENTE no bloquea: el auto-orden usa el número
    //    desde el que escribe la persona (pedírselo sería el tic absurdo que
    //    contextoColumna ya corrigió). Solo bloquea si vino y es falsa.
    const sinLineaTelefono = valido.replace(/📞 Telefono: 0979462998\n/, '');
    caso(
      'cierre completo sin línea de teléfono sigue pasando (respaldo del chat)',
      motivoCierreInvalido(sinLineaTelefono) === null,
      `motivo=${motivoCierreInvalido(sinLineaTelefono)}`,
    );

    // e) La petición del paso 12 pide EXACTAMENTE lo que el candado bloqueó.
    const { camposFaltantesCierre } = require('../src/services/kanban_ia.service');
    const faltanSolanda = camposFaltantesCierre(sinCiudadNiDir);
    caso(
      'camposFaltantesCierre pide solo ciudad y dirección en el caso Solanda',
      faltanSolanda.length === 2 &&
        /Ciudad/.test(faltanSolanda[0]) &&
        /Direcci/.test(faltanSolanda[1]),
      JSON.stringify(faltanSolanda),
    );
  }

  // 10. Resumen multi-producto (caso 889, Nicolas: "Reloj SKMEI Multifuncion,
  //     1 x Reloj Steel Arabe" en UNA línea → la orden cayó a manual). El
  //     formato correcto es una línea 📦 por producto; el parser convierte
  //     eso en renglones para el auto-orden y NO toca el caso de una línea.
  {
    const {
      parsearProductosResumen,
    } = require('../src/services/kanban_ia.service');

    const dosLineas =
      'Listo! Pedido confirmado:\n🧑 Nombre: Nicolas Prueba\n' +
      '📞 Telefono: 0960231042\n📍 Ciudad: Machala\n🏡 Direccion: Calle 1 y 2\n' +
      '📦 Producto: Reloj SKMEI Multifuncion x1 (Variedad: NEGRO)\n' +
      '📦 Producto: Reloj Steel Arabe x2\n' +
      '💰 Precio total: 74.99\n[generar_guia]:true';
    const items = parsearProductosResumen(dosLineas);
    caso(
      'resumen con dos líneas 📦 se parsea en 2 renglones',
      items.length === 2,
      JSON.stringify(items),
    );
    caso(
      'renglón 1: nombre limpio, cantidad 1 y variedad NEGRO',
      items[0]?.producto === 'Reloj SKMEI Multifuncion' &&
        items[0]?.cantidad === '1' &&
        items[0]?.variedad === 'NEGRO',
      JSON.stringify(items[0]),
    );
    caso(
      'renglón 2: cantidad 2 y sin variedad',
      items[1]?.producto === 'Reloj Steel Arabe' &&
        items[1]?.cantidad === '2' &&
        items[1]?.variedad === '',
      JSON.stringify(items[1]),
    );

    // Cantidad al inicio ("2 x Reloj…"), como lo escriben algunos bots.
    const alInicio = parsearProductosResumen(
      '📦 Producto: 2 x Reloj Steel Arabe\n📦 Producto: Evil Goods x1\n',
    );
    caso(
      'cantidad al inicio ("2 x …") también se lee',
      alInicio[0]?.cantidad === '2' &&
        alInicio[0]?.producto === 'Reloj Steel Arabe',
      JSON.stringify(alInicio[0]),
    );

    // Una sola línea 📦 → [] : el flujo de un producto no cambia en nada,
    // aunque la línea traiga comas (el caso Nicolas sigue yendo a manual,
    // donde ahora sí se puede armar con 2 productos).
    const unaLinea = parsearProductosResumen(
      '📦 Producto: Reloj SKMEI Multifuncion, 1 x Reloj Steel Arabe\n💰 Precio total: 74.99',
    );
    caso(
      'una sola línea 📦 (aún con comas) NO activa el modo multi-producto',
      Array.isArray(unaLinea) && unaLinea.length === 0,
      JSON.stringify(unaLinea),
    );
  }

  // 11. Fuga del acuse en el remarketing IA (caso 569, 2026-08-19): al
  //     cliente le llegó "¡Entendido! 😊 Aquí tienes el mensaje de
  //     remarketing:" antes del mensaje real. limpiarMetaRemarketing corta el
  //     acuse y la jerga interna SIN tocar mensajes legítimos.
  {
    const {
      limpiarMetaRemarketing,
    } = require('../src/services/kanban_ia.service');

    // El mensaje real que se filtró en la 569
    const filtrado = limpiarMetaRemarketing(
      '¡Entendido! 😊 Aquí tienes el mensaje de remarketing:\n\n' +
        'Quiero informarte que hemos reservado un descuento exclusivo del 5% ' +
        'para ti en el *Shampoo Cubre Canas IVSI 400gr*.\n\n' +
        '🟢 Precio con descuento: $21.84\n\n¿Te gustaría aprovecharlo? 📍',
    );
    caso(
      'el acuse "Aquí tienes el mensaje de remarketing:" se corta (caso 569)',
      filtrado.startsWith('Quiero informarte') && !/remarketing/i.test(filtrado),
      filtrado.slice(0, 60),
    );

    // Acuse solo en su propia línea, sin nombrar el mensaje
    const acuseSolo = limpiarMetaRemarketing(
      '¡Entendido!\nHola María, tu pedido sigue reservado. ¿Lo confirmamos hoy? 😊',
    );
    caso(
      'un "¡Entendido!" solo en la primera línea se corta',
      acuseSolo.startsWith('Hola María'),
      acuseSolo.slice(0, 50),
    );

    // Mensaje legítimo que ARRANCA con "¡Perfecto!" en la misma línea: intacto
    const legitimo =
      '¡Perfecto! Tu descuento del 10% sigue activo hasta las 20:00. ¿Aprovechamos? 😊';
    caso(
      'un mensaje legítimo que arranca con "¡Perfecto!" no se toca',
      limpiarMetaRemarketing(legitimo) === legitimo,
    );

    // Fail-safe: si limpiar deja el texto vacío, vuelve el original
    const soloJerga = '[ACCIÓN INTERNA: GENERAR_REMARKETING]';
    caso(
      'fail-safe: si todo era jerga, devuelve el original (no un vacío)',
      limpiarMetaRemarketing(soloJerga) === soloJerga,
    );
  }

  // 12. Ficha del pedido (casos 302 Josué y 360 Delfin, 2026-08-19/20): el
  //     cierre se completa con lo que el cliente YA dijo en vez de pedírselo
  //     otra vez; el cierre "narrado" sin tag se reconoce; y la ficha no
  //     inventa (cada valor tiene que estar en las palabras del cliente).
  {
    const {
      completarResumenConFicha,
      esCierreNarrado,
      pareceResumenDePedido,
      faltantesFicha,
      bloqueFichaPedido,
      aparecioEnCliente,
    } = require('../src/utils/fichaPedido');
    const { motivoCierreInvalido } = require('../src/services/kanban_ia.service');

    // a) Caso 302 (Josué): "Nombre: Josué" con el apellido dicho por el cliente,
    //    y "gracias por tu compra" SIN tag → cierre narrado con resumen.
    const r302 =
      '¡Perfecto, Josué! 😊 Aquí tienes el resumen de tu pedido:\n\n' +
      '🧑 **Nombre:** Josué  \n📞 **Teléfono:** 0995438411  \n' +
      '📍 **Provincia:** Pichincha  \n📍 **Ciudad:** Quito  \n' +
      '🏡 **Dirección:** Vilcabamba  \n🔖 **Referencia:** Licorería Vivanco  \n' +
      '📦 **Producto:** Cinturón Anticólicos x1  \n💰 **Total:** $21.99\n\n' +
      '¡Muchas gracias por tu compra! 😊 Agradecemos tu confianza.';
    const ficha302 = {
      nombre: 'Josué yumbulema',
      telefono: '0995438411',
      ciudad: 'Quito',
      provincia: 'Pichincha',
      direccion: 'Vilcabamba',
      referencia: 'licorería Vivanco',
      entrega: 'domicilio',
      agencia: '',
      producto: 'Cinturón Anticólicos',
      cantidad: '1',
      variedad: '',
      confirmo_pedido: true,
    };
    caso(
      'caso 302: "gracias por tu compra" + resumen sin tag se reconoce como cierre narrado',
      esCierreNarrado(r302) && pareceResumenDePedido(r302),
    );
    const c302 = completarResumenConFicha(r302, ficha302);
    caso(
      'caso 302: el nombre de una palabra se completa con el apellido que dio el cliente',
      c302.completados.includes('nombre') &&
        /Nombre:\*\* Josué yumbulema/.test(c302.texto) &&
        motivoCierreInvalido(c302.texto) === null,
      `completados=${c302.completados} motivo=${motivoCierreInvalido(c302.texto)}`,
    );

    // b) Caso 360 (Delfin, retiro en agencia): resumen con solo
    //    Producto/Precio/Envío → se completa Nombre, Provincia, Ciudad y la
    //    agencia por confirmar, y el validador lo deja pasar.
    const r360 =
      'Aquí está el resumen:\n\n📦 Producto: Mascara protectora facial transparente x2  \n' +
      '💰 Precio total: $19.99  \n🚚 Envío: Agencia Servientrega, Orellana\n\n' +
      'Gracias por tu compra. ¡Tu hija podrá retirar y pagar al momento!  \n[generar_guia]:true';
    const ficha360 = {
      nombre: 'Delfin Alvarado',
      telefono: '0961871183',
      ciudad: 'Coca',
      provincia: 'Orellana',
      direccion: '',
      referencia: '',
      entrega: 'agencia',
      agencia: '',
      producto: 'Mascara protectora facial transparente',
      cantidad: '2',
      variedad: '',
      confirmo_pedido: false,
    };
    caso(
      'caso 360: el resumen sin nombre/ciudad se bloqueaba antes de la ficha',
      motivoCierreInvalido(r360) !== null,
    );
    const c360 = completarResumenConFicha(r360, ficha360);
    caso(
      'caso 360: la ficha completa nombre, provincia, ciudad y agencia y el cierre pasa',
      ['nombre', 'provincia', 'ciudad', 'agencia'].every((k) =>
        c360.completados.includes(k),
      ) &&
        /Nombre: Delfin Alvarado/.test(c360.texto) &&
        /Direccion: Agencia Servientrega por confirmar — Coca/.test(c360.texto) &&
        motivoCierreInvalido(c360.texto) === null,
      `completados=${c360.completados} motivo=${motivoCierreInvalido(c360.texto)}`,
    );

    // c) Placeholders del prompt: se reemplazan por lo que el cliente dio; la
    //    línea de teléfono falsa se quita si el cliente no dio número.
    const rPh =
      'Listo! Pedido confirmado:\n🧑 Nombre: [nombre completo]\n📞 Telefono: [tu numero]\n' +
      '📍 Ciudad: Quito\n🏡 Direccion: (pendiente)\n📦 Producto: Reloj x1\n💰 Precio total: $20\n[generar_guia]:true';
    const cPh = completarResumenConFicha(rPh, {
      nombre: 'Ana María Pérez',
      telefono: '',
      ciudad: 'Quito',
      provincia: 'Pichincha',
      direccion: 'Av. Amazonas y Colón',
      referencia: 'frente al parque',
      entrega: 'domicilio',
    });
    caso(
      'placeholders del resumen se reemplazan con la ficha y el cierre pasa',
      /Nombre: Ana María Pérez/.test(cPh.texto) &&
        !/\[tu numero\]/.test(cPh.texto) &&
        /Direccion: Av\. Amazonas y Colón \(frente al parque\)/.test(cPh.texto) &&
        motivoCierreInvalido(cPh.texto) === null,
      `motivo=${motivoCierreInvalido(cPh.texto)}`,
    );

    // d) Lo que NO se toca: sin ficha, sin resumen, o un nombre DISTINTO al
    //    de la ficha (ahí decide el validador, no se pisa).
    caso(
      'sin resumen reconocible no se completa nada',
      completarResumenConFicha('¡Gracias por tu compra!', ficha302).completados
        .length === 0,
    );
    const otroNombre = r302.replace('Josué  ', 'Carlos  ');
    caso(
      'un nombre distinto al de la ficha no se pisa',
      !completarResumenConFicha(otroNombre, ficha302).completados.includes(
        'nombre',
      ),
    );
    caso(
      'un "pedido registrado" sin resumen NO se infiere como cierre',
      esCierreNarrado('¡Tu pedido ha sido registrado con éxito! Gracias') &&
        !pareceResumenDePedido('¡Tu pedido ha sido registrado con éxito! Gracias'),
    );

    // e) Qué falta según la ficha = el mismo criterio del validador.
    caso(
      'ficha: retiro en agencia con ciudad NO pide dirección',
      faltantesFicha(ficha360).length === 0,
      JSON.stringify(faltantesFicha(ficha360)),
    );
    caso(
      'ficha: nombre de pila solo pide el APELLIDO, no el nombre otra vez',
      /Apellido/.test(faltantesFicha({ ...ficha302, nombre: 'Josué' }).join(' ')),
    );
    caso(
      'ficha vacía pide nombre, ciudad y dirección/agencia (no teléfono)',
      (() => {
        const f = faltantesFicha({}).join(' | ');
        return /Nombre completo/.test(f) && /Ciudad/.test(f) && /Direcci/.test(f) && !/Tel/.test(f);
      })(),
    );
    const bloqueAg = bloqueFichaPedido(ficha360, { trigger: '[generar_guia]:true' });
    caso(
      'bloque de ficha en agencia: prohíbe pedir dirección de domicilio y dicta el cierre',
      /NO existe dirección de domicilio/.test(bloqueAg) &&
        /No falta ningún dato/.test(bloqueAg) &&
        /\[generar_guia\]:true/.test(bloqueAg),
    );
    caso(
      'bloque de ficha con faltante: dice qué falta y no dicta el cierre todavía',
      (() => {
        const b = bloqueFichaPedido({ ...ficha302, nombre: 'Josué' }, {});
        return /❌ FALTA: Apellido/.test(b) && /pide SOLO lo que está en ❌/.test(b);
      })(),
    );

    // g) Apellido en mensaje aparte (prueba 610 del 2026-08-20): "Josué" → el
    //    bot pide el apellido → "Yumbulema, mi teléfono es…" = Josué Yumbulema.
    //    Y un "Listo"/"Quito" después de pedir el apellido NO es apellido.
    const { completarApellido } = require('../src/utils/fichaPedido');
    const charla = [
      { rol: 'CLIENTE', texto: 'Josué' },
      { rol: 'ASISTENTE', texto: 'Genial, Josué. Para proceder, necesito tu apellido y la dirección exacta.' },
      { rol: 'CLIENTE', texto: 'Yumbulema, mi teléfono es 0995438411' },
    ];
    caso(
      'apellido dado en otro mensaje se une al nombre de pila',
      completarApellido('Josué', charla) === 'Josué Yumbulema',
      completarApellido('Josué', charla),
    );
    caso(
      'un "Listo" después de pedir el apellido no se toma como apellido',
      completarApellido('Josué', [charla[0], charla[1], { rol: 'CLIENTE', texto: 'Listo' }]) === 'Josué' &&
        completarApellido('Delfin Alvarado', charla) === 'Delfin Alvarado',
    );

    // h) ¿Qué producto nombra el texto? (caso 405, Celia, 2026-08-20): "nombre
    //    completo… para completar el pedido" NO es el "Kit Completo 800
    //    vinchas para Auto"; las palabras vacías y genéricas no cuentan, el
    //    match es por palabra entera y gana el nombre más específico.
    const { productoNombrado } = require('../src/utils/productoNombrado');
    const catalogo405 = [
      { id: 1160, nombre: 'Kit Completo 800 vinchas para Auto' },
      { id: 2205, nombre: 'Pistola Masajeador Muscular' },
      { id: 3983, nombre: 'Boquilla a Presión de Manguera' },
      { id: 9, nombre: 'Cabezal de ducha' },
    ];
    caso(
      'pedir "nombre completo… para completar el pedido" no adjunta la foto de las vinchas',
      productoNombrado(
        'Ahora, solo me falta tu nombre completo, teléfono y dirección exacta (2 calles + referencia) para completar el pedido.',
        catalogo405,
      ) === null,
    );
    caso(
      'nombrar la Boquilla a Presión de Manguera sí la identifica',
      productoNombrado('vamos a enviarte la *Boquilla a Presión de Manguera* a tu domicilio', catalogo405)?.id === 3983,
    );
    caso(
      'el kit de vinchas se identifica cuando de verdad se nombra',
      productoNombrado('quiero el kit de 800 vinchas para el auto', catalogo405)?.id === 1160,
    );
    caso(
      '"cabeza" no es "Cabezal de ducha" (palabra entera, no substring)',
      productoNombrado('¿protege la cabeza?', catalogo405) === null &&
        productoNombrado('quiero el cabezal de ducha', catalogo405)?.id === 9,
    );

    // f) Anti-invento: un valor que no está en las palabras del cliente no vale.
    caso(
      'anti-invento: el nombre tiene que estar en lo que escribió el cliente',
      aparecioEnCliente('Josué Yumbulema', 'mi nombre es josue yumbulema') &&
        !aparecioEnCliente('Pedro Pérez', 'hola soy Juan') &&
        aparecioEnCliente('0961871183', 'mi número es 0961871183', { esTelefono: true }),
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
