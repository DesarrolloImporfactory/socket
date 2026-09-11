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

    // g) Typo de ciudad (caso UP NOW 2026-09-01): "Guayuquil" es Guayaquil y
    //    la ficha no debe volver a pedir la ciudad. El anti-invento sigue:
    //    "quiero" NO es Quito.
    const { ciudadAproxEnCliente } = require('../src/utils/fichaPedido');
    caso(
      'ciudad con typo: "guayuquil" cuenta como Guayaquil',
      ciudadAproxEnCliente('Guayaquil', 'mandalo a guayuquil porfa') === true,
    );
    caso(
      'ciudad con typo: "quiero 2 frascos" NO es Quito (anti-invento intacto)',
      ciudadAproxEnCliente('Quito', 'quiero 2 frascos') === false,
    );
    caso(
      'ciudad con typo: nombre compuesto ("santo dmingo" → Santo Domingo)',
      ciudadAproxEnCliente('Santo Domingo', 'vivo en santo dmingo') === true,
    );
    caso(
      'ciudad con typo: las cortas (Loja) solo valen exactas',
      ciudadAproxEnCliente('Loja', 'hola buenas') === false &&
        ciudadAproxEnCliente('Loja', 'soy de loja') === true,
    );
    const { corregirCiudadTypo } = require('../src/utils/fichaPedido');
    caso(
      'ciudad con typo: "Guayuquil" se corrige a Guayaquil (para el auto-orden)',
      corregirCiudadTypo('Guayuquil') === 'Guayaquil' &&
        corregirCiudadTypo('Quevedo') === 'Quevedo' &&
        corregirCiudadTypo('quiero') === 'quiero',
    );
    /* Ciudad a medias (cfg 1125, 2026-09-11): el cliente cerró con "Quit
       pichincha" y la orden salía a Dropi con la ciudad "Quit". Con 4 letras y
       una sola ciudad que empiece así, se completa. */
    caso(
      'ciudad a medias: "Quit" se completa a Quito (y "Guayaqui" a Guayaquil)',
      corregirCiudadTypo('Quit') === 'Quito' &&
        corregirCiudadTypo('Guayaqui') === 'Guayaquil',
    );
    caso(
      'ciudad a medias: "sant" es ambigua (Santa Elena / Santo Domingo) → no se adivina',
      corregirCiudadTypo('sant') === 'sant',
    );
    caso(
      'ciudad a medias: "quie" no es Quito (no es su arranque) → se deja',
      corregirCiudadTypo('quie') === 'quie',
    );

    // El validador del cierre tampoco debe tratar la corrección como invento:
    // "Ciudad: Guayaquil" con el cliente habiendo escrito "guayuquil" pasa.
    const { camposFaltantesCierre: faltantesTypo } = require('../src/services/kanban_ia.service');
    const resumenTypo = [
      '🧑 Nombre: Michael Ordonez',
      '📞 Telefono: 0962803007',
      '📍 Provincia: Guayas',
      '📍 Ciudad: Guayaquil',
      '🏡 Direccion: calderon calle geovanny rivera frente al portal',
      '📦 Producto: Up Now',
      '🔢 Cantidad: 3',
      '💰 Precio total: $39.99',
      '🚚 Envio: domicilio',
    ].join('\n');
    caso(
      'cierre: la ciudad corregida de un typo del cliente NO cuenta como inventada',
      (() => {
        const f = faltantesTypo(resumenTypo, {
          _textoCliente: 'tiene 16\nguayuquil\ndame 3\ndomicilio\nMichael Ordonez, calderon calle geovanny rivera frente al portal, 0962803007',
        });
        return !f.some((x) => /Ciudad/i.test(x));
      })(),
    );
    caso(
      'cierre: una ciudad que el cliente JAMÁS escribió sigue bloqueando',
      (() => {
        const f = faltantesTypo(resumenTypo, {
          _textoCliente: 'tiene 16\ndame 3\ndomicilio\nMichael Ordonez, mi direccion es el centro, 0962803007',
        });
        return f.some((x) => /Ciudad/i.test(x));
      })(),
    );
  }

  /* ── Flujo de venta por pasos (embudo manual del wizard) ──
     Validadores PUROS: deciden si la respuesta del cliente avanza el embudo
     (copy fijo, 0 tokens) o cae a respuestas rápidas / IA. Nacen con el caso
     UP NOW (cfg 1028): edad 10-22, "Ecuador" no es una ciudad, y la promo se
     elige por número o precio. */
  {
    const {
      validarPasoFlujo,
      extraerEdad,
      pasosDelFlujo,
    } = require('../src/services/producto_wizard_runtime.service');

    const pasoEdad = {
      espera: 'edad', min: 10, max: 22,
      copy: 'beneficios…', copy_invalido: 'aún es pequeño…',
    };
    caso(
      'flujo edad: "tiene 15 años" valida y extrae 15',
      validarPasoFlujo(pasoEdad, 'tiene 15 años').valida === true &&
        extraerEdad('tiene 15 años') === 15,
    );
    caso(
      'flujo edad: "doce" en palabras también valida',
      validarPasoFlujo(pasoEdad, 'doce').valida === true,
    );
    caso(
      'flujo edad: 9 años queda fuera de rango (no valida, marca fuera_rango)',
      (() => {
        const v = validarPasoFlujo(pasoEdad, 'tiene 9 añitos');
        return v.valida === false && v.fuera_rango === true && v.edad === 9;
      })(),
    );
    caso(
      'flujo edad: una pregunta sin edad NO valida (cae a FAQ/IA)',
      validarPasoFlujo(pasoEdad, 'tiene registro sanitario?').valida === false,
    );

    const pasoCiudad = {
      espera: 'ciudad', copy: 'envío gratis…',
      casos: [{ contiene: ['ecuador'], copy: '¿De qué ciudad del Ecuador?' }],
    };
    caso(
      'flujo ciudad: "Quito" valida',
      validarPasoFlujo(pasoCiudad, 'Quito').valida === true,
    );
    caso(
      'flujo ciudad: "Ecuador" dispara el caso especial sin avanzar',
      (() => {
        const v = validarPasoFlujo(pasoCiudad, 'de ecuador');
        return v.valida === false && !!v.caso;
      })(),
    );
    caso(
      'flujo ciudad: una pregunta con "?" NO valida',
      validarPasoFlujo(pasoCiudad, 'hacen envíos a todo el país?').valida === false,
    );
    // Caso real UP NOW (2026-09-01): "tiene registro sanitario" sin "?" se
    // tomaba como ciudad y el bot contestó "envíos GRATIS a Tiene Registro
    // Sanitario". Corto y sin "?" NO basta.
    caso(
      'flujo ciudad: "tiene registro sanitario" (sin ?) NO es una ciudad',
      validarPasoFlujo(pasoCiudad, 'tiene registro sanitario').valida === false,
    );
    caso(
      'flujo ciudad: "el domingo le confirmo" NO es una ciudad',
      validarPasoFlujo(pasoCiudad, 'el domingo le confirmo').valida === false,
    );
    caso(
      'flujo ciudad: "estoy en quito" valida y extrae el lugar "quito"',
      (() => {
        const v = validarPasoFlujo(pasoCiudad, 'estoy en quito');
        return v.valida === true && v.lugar === 'quito';
      })(),
    );
    caso(
      'flujo ciudad: "santo domingo" valida (nombre compuesto)',
      validarPasoFlujo(pasoCiudad, 'santo domingo').valida === true,
    );
    caso(
      'flujo ciudad: una ciudad chica desconocida corta también valida',
      validarPasoFlujo(pasoCiudad, 'pelileo').valida === true,
    );

    const pasoPromo = {
      espera: 'opcion',
      opciones: [
        { claves: ['1', '24.99', 'uno', 'un frasco'], copy: 'elegiste 1…' },
        { claves: ['2', '32.99', 'dos'], copy: 'elegiste 2…' },
        { claves: ['3', '39.99', 'tres', 'completo'], copy: 'elegiste 3…' },
      ],
    };
    caso(
      'flujo opción: "el de 39.99" matchea la promo 3',
      (() => {
        const v = validarPasoFlujo(pasoPromo, 'el de 39.99');
        return v.valida === true && v.indice === 2;
      })(),
    );
    caso(
      'flujo opción: la clave corta "1" no matchea dentro de "21.99"',
      validarPasoFlujo(pasoPromo, 'vi uno de 21.99 en otro lado').valida === false ||
        validarPasoFlujo(pasoPromo, 'vi algo de 21.99 por ahi').valida === false,
    );
    caso(
      'flujo opción: respuesta ambigua ("1 o 2?") NO avanza',
      validarPasoFlujo(pasoPromo, 'mejor 1 o 2?').valida === false,
    );

    // Ronda UP NOW 2026-09-01 (2ª tanda de casos reales):
    caso(
      'flujo edad: "tiene19" pegado sin espacio también valida',
      validarPasoFlujo(pasoEdad, 'tiene19').valida === true &&
        extraerEdad('tiene19') === 19,
    );
    const pasoEnvio = {
      espera: 'opcion',
      opciones: [
        { claves: ['domicilio', 'casa'], copy: 'a domicilio…' },
        { claves: ['servientrega', 'agencia'], copy: 'a servientrega…' },
      ],
    };
    caso(
      'flujo opción: el typo "a domiclo" matchea DOMICILIO',
      (() => {
        const v = validarPasoFlujo(pasoEnvio, 'a domiclo');
        return v.valida === true && v.indice === 0;
      })(),
    );
    caso(
      'flujo opción: "serbientrega" matchea SERVIENTREGA',
      (() => {
        const v = validarPasoFlujo(pasoEnvio, 'serbientrega porfa');
        return v.valida === true && v.indice === 1;
      })(),
    );
    caso(
      'flujo opción: pedido complejo ("dos combos de 3, es decir 6") va a la IA',
      (() => {
        const v = validarPasoFlujo(pasoPromo, 'puedes ayudarme con dos combos de 3 porfa. es decir 6');
        return v.valida === false && v.pedido_complejo === true;
      })(),
    );
    caso(
      'flujo opción: "dos combos de x 3porfa" también es pedido complejo (no elige la promo 2)',
      validarPasoFlujo(pasoPromo, 'dos combos de x 3porfa').pedido_complejo === true,
    );
    caso(
      'flujo opción: "dame 3 por favor" (un solo número) sigue eligiendo la promo 3',
      (() => {
        const v = validarPasoFlujo(pasoPromo, 'dame 3 por favor');
        return v.valida === true && v.indice === 2;
      })(),
    );
    // Caso real 782: "quiero adquirir el army bomb" no identificaba
    // "ARMY BOMB LIGTHSTICK BTS V4" (2/4 = 50% < 60%) y el paquete fijo
    // jamás salió. Nombrar el ARRANQUE del nombre identifica; los guardas
    // viejos ("el cargador" ambiguo, dos productos que arrancan igual) siguen.
    const {
      elegirProductoPorTexto,
    } = require('../src/services/producto_wizard_runtime.service');
    caso(
      'resolver por texto: "army bomb" identifica el nombre largo (arranque)',
      elegirProductoPorTexto('quiero adquirir el army bomb', [
        { id: 1, nombre: 'ARMY BOMB LIGTHSTICK BTS V4' },
        { id: 2, nombre: 'Reloj SKMEI Multifuncion' },
      ])?.id === 1,
    );
    caso(
      'resolver por texto: "el cargador" solo sigue siendo ambiguo (no calza)',
      elegirProductoPorTexto('quiero el cargador', [
        { id: 1, nombre: 'Cargador de Bateria Rapido' },
        { id: 2, nombre: 'Cargador Inalambrico Premium' },
      ]) === null,
    );
    caso(
      'resolver por texto: dos productos con el mismo arranque empatan → IA',
      elegirProductoPorTexto('quiero el army bomb', [
        { id: 1, nombre: 'ARMY BOMB LIGTHSTICK BTS V4' },
        { id: 2, nombre: 'ARMY BOMB LIGTHSTICK BTS V3' },
      ]) === null,
    );
    /* Caso cfg 1125, 2026-09-11: el embudo "explotaba" cuando el cliente se
       desviaba. Un paso libre se tragaba la pregunta (avanzaba sin
       contestarla) y la dirección de solo calles cerraba pedidos que la
       transportadora no podía entregar. */
    caso(
      'flujo libre: una pregunta NO avanza el paso (la contesta la rápida/IA y retoma)',
      validarPasoFlujo({ espera: 'libre', copy: 'gracias' }, '¿hacen envíos a Cuenca?')
        .valida === false,
    );
    caso(
      'flujo libre: una respuesta normal sigue avanzando',
      validarPasoFlujo({ espera: 'libre', copy: 'gracias' }, 'Av. Amazonas 123')
        .valida === true,
    );
    caso(
      'flujo ciudad: "hacen envíos a Cuenca" contesta el paso (la ciudad manda)',
      validarPasoFlujo({ espera: 'ciudad', copy: 'envío gratis…' }, 'hacen envios a cuenca')
        .valida === true,
    );

    /* Salto por dato adelantado (cfg 1125, Super Cacao): el cliente escribió
       "hacen envíos a cuenca" en la pregunta gancho y tres mensajes después el
       embudo le preguntaba la ciudad que ya había dicho. */
    const {
      buscarPasoAdelantado,
      buscarPasoPorCompra,
    } = require('../src/services/producto_wizard_runtime.service');
    const pasosCacao = [
      { espera: 'libre', pregunta: '❓CUÁNTAS HORAS DUERMES❓', copy: 'pitch… ❓DE QUÉ CIUDAD❓' },
      { espera: 'ciudad', pregunta: '❓DE QUÉ CIUDAD❓', copy: 'a {{respuesta}} llega en 2-3 días' },
      {
        espera: 'opcion', pregunta: '❓CUÁNTOS FRASCOS❓', copy: 'dame tus datos',
        opciones: [{ claves: ['1', 'uno'], copy: 'uno' }, { claves: ['2', 'dos'], copy: 'dos' }],
      },
    ];
    caso(
      'salto: "hacen envios a cuenca" en el paso 0 adelanta el embudo al paso de la ciudad',
      (() => {
        const s = buscarPasoAdelantado(pasosCacao, 0, 'hacen envios a cuenca');
        return s && s.indice === 1 && s.v.lugar === 'cuenca';
      })(),
    );
    caso(
      'salto: un número suelto ("3") NO adelanta el embudo (significa otra cosa en cada paso)',
      buscarPasoAdelantado(pasosCacao, 0, '3') === null,
    );
    caso(
      'salto: "esta bien" NO adelanta (no es una ciudad reconocida)',
      buscarPasoAdelantado(pasosCacao, 0, 'esta bien') === null,
    );
    caso(
      'salto: un paso libre posterior nunca atrapa el salto',
      buscarPasoAdelantado(
        [{ espera: 'ciudad', copy: 'c' }, { espera: 'libre', copy: 'l' }],
        0,
        'cualquier cosa',
      ) === null,
    );

    /* Compra explícita en la pregunta gancho (mismo caso 1125): "quiero 2" se
       leía como 2 horas de sueño y la promo se volvía a preguntar después. */
    const pasosPromo = [
      ...pasosCacao,
      {
        espera: 'opcion', pregunta: '❓DOMICILIO O AGENCIA❓', copy: 'perfecto',
        opciones: [{ claves: ['domicilio'], copy: 'd' }, { claves: ['agencia'], copy: 'a' }],
      },
    ];
    caso(
      'compra: "quiero 2" en la pregunta gancho adelanta el embudo a la promo',
      (() => {
        const s = buscarPasoPorCompra(pasosPromo, 0, 'quiero 2');
        return s && s.indice === 2 && s.v.indice === 1;
      })(),
    );
    caso(
      'compra: un "2" pelado NO adelanta (en la pregunta gancho son las horas)',
      buscarPasoPorCompra(pasosPromo, 0, '2') === null,
    );
    caso(
      'compra: en el paso de la promo no salta a la siguiente opción',
      buscarPasoPorCompra(pasosPromo, 2, 'quiero 2') === null,
    );

    /* Post-venta (cfg 1125): cerrada la venta, la quemada sale SIN la pregunta
       de cierre. En vivo el remate lo pone el código (conCierreDeVenta) y por
       eso las 11 quemadas del Super Cacao terminan preguntando; después del
       cierre eso sería empujarle otra compra a quien ya compró. */
    {
      const {
        textoPostVenta,
      } = require('../src/services/producto_wizard_runtime.service');
      const {
        conCierreDeVenta,
        terminaPreguntando,
      } = require('../src/utils/wizardProducto/cierreVenta');
      const sinPregunta = '🎁 Mándanos la foto con tu frasco y entras al sorteo.';
      const conPregunta =
        'El envío es gratis y pagas al recibir. 💵\n\n¿Te confirmo tu pedido? 😊';
      caso(
        'post-venta: la quemada normal sale igual pero SIN remate de venta',
        terminaPreguntando(conCierreDeVenta(sinPregunta, 1)) &&
          textoPostVenta(sinPregunta) === sinPregunta,
      );
      /* Las respuestas de después del cierre son una LISTA APARTE de las
         rápidas: viven en flujo_pasos_json como espera:'post_venta'. Sin ella
         configurada, después del cierre no se contesta nada. */
      const {
        respuestasPostVenta,
      } = require('../src/services/producto_wizard_runtime.service');
      caso(
        'post-venta: la lista propia se lee de flujo_pasos_json',
        respuestasPostVenta({
          flujo_pasos_json: JSON.stringify([
            { espera: 'ciudad', copy: 'c' },
            { espera: 'venta_realizada', copy: 'gracias' },
            {
              espera: 'post_venta',
              faqs: [
                { pregunta: 'sorteo', respuesta: 'mándanos la foto', claves: ['sorteo'] },
                { pregunta: 'apagada', respuesta: 'x', activa: 0 },
              ],
            },
          ]),
        }).length === 1,
      );
      /* Typos reales del cliente (cfg 1125, 2026-09-11): "comp aprtiicpo en el
         sorteo" no calzaba y el cliente quedaba sin respuesta. Después del
         cierre el matcher se relaja (una clave basta, tolerando el typo de
         dedos) porque el silencio ahí es peor que una respuesta de más. */
      {
        const {
          elegirPostVenta,
        } = require('../src/services/producto_wizard_runtime.service');
        const lista = [
          {
            pregunta: 'COMO PARTICIPO EN EL SORTEO',
            respuesta: 'Mándanos la foto con tu frasco y entras al sorteo.',
            claves: ['sorteo', 'rifa', 'premio', 'participo'],
          },
          {
            pregunta: 'CAMBIAR LA DIRECCION',
            respuesta: 'Escríbenos la dirección correcta y un asesor la ajusta.',
            claves: ['cambiar la direccion', 'me equivoque en la direccion'],
          },
        ];
        const pega = (m) => elegirPostVenta(m, lista)?.faq.pregunta || null;
        caso(
          'post-venta: "comp aprtiicpo en el sorteo" (typos) igual se contesta',
          pega('comp aprtiicpo en el sorteo') === 'COMO PARTICIPO EN EL SORTEO',
        );
        caso(
          'post-venta: "sortoe" (letras cambiadas de lugar) también',
          pega('comp articpio e nel sortoe') === 'COMO PARTICIPO EN EL SORTEO',
        );
        caso(
          'post-venta: "soltero" NO se confunde con "sorteo"',
          pega('soy soltero') === null,
        );
        caso(
          'post-venta: un reclamo largo queda para una persona',
          pega('quiero reclamar porque el producto llego roto y quiero que me devuelvan mi plata ya mismo') === null,
        );
        caso(
          'post-venta: "gracias" no dispara nada',
          pega('gracias') === null,
        );
      }

      caso(
        'post-venta: sin lista configurada no se contesta nada',
        respuestasPostVenta({
          flujo_pasos_json: JSON.stringify([{ espera: 'ciudad', copy: 'c' }]),
        }).length === 0,
      );
      caso(
        'post-venta: la entrada post_venta NO es un paso de la secuencia',
        pasosDelFlujo({
          usar_flujo_pasos: 1,
          flujo_pasos_json: JSON.stringify([
            { espera: 'ciudad', copy: 'c' },
            { espera: 'post_venta', faqs: [{ pregunta: 'a', respuesta: 'b' }] },
          ]),
        }).length === 1,
      );
      caso(
        'post-venta: si el negocio escribió la pregunta dentro, se recorta',
        textoPostVenta(conPregunta) === 'El envío es gratis y pagas al recibir. 💵',
      );
      caso(
        'post-venta: una quemada que es solo pregunta → silencio, no se contesta',
        textoPostVenta('¿Te confirmo tu pedido? 😊') === '',
      );
      caso(
        'post-venta: durante la venta esa quemada NO se toca',
        conCierreDeVenta(conPregunta, 1) === conPregunta,
      );
    }

    /* Qué columnas cuentan como post-venta. La primera versión barría TODOS
       los cambiar_estado y marcaba "contacto inicial" y "asesor": ahí la
       quemada habría salido sin su remate EN PLENA VENTA. */
    {
      const {
        esColumnaPostVenta,
      } = require('../src/services/producto_wizard_runtime.service');
      const sinIA = { exigirSinIA: false };
      caso(
        'post-venta: la columna donde se VENDE nunca cuenta como post-venta',
        (await esColumnaPostVenta(CFG_DROPI, 'contacto_inicial', sinIA)) === false,
      );
      caso(
        'post-venta: el destino del cierre (generar_guia) sí cuenta',
        (await esColumnaPostVenta(CFG_DROPI, 'generar_guia', sinIA)) === true,
      );
      caso(
        'post-venta: las columnas del flujo Dropi (en tránsito) sí cuentan',
        (await esColumnaPostVenta(CFG_DROPI, 'en_transito', sinIA)) === true,
      );
      caso(
        'post-venta: una columna inexistente no cuenta',
        (await esColumnaPostVenta(CFG_DROPI, 'no_existe_esta', sinIA)) === false,
      );
    }

    /* Candado de la dirección a domicilio (cfg 1125): "dos calles y nada más"
       es una guía que vuelve como NO ENTREGADA. Se pide UNA vez la numeración
       y la referencia; a la segunda se ofrece la agencia Servientrega. */
    const {
      direccionIncompleta,
      intentosPedirReferencia,
      faltantesFicha: faltantesDir,
      bloqueFichaPedido: bloqueDir,
    } = require('../src/utils/fichaPedido');
    const dirSolaCalles = {
      entrega: 'domicilio',
      nombre: 'Ana Perez',
      ciudad: 'Quito',
      direccion: 'Juan Montalvo y Sucre',
      producto: 'X',
      cantidad: '1',
    };
    caso(
      'dirección: solo calles es incompleta',
      direccionIncompleta(dirSolaCalles) === true,
    );
    caso(
      'dirección: "Av. 10 de Agosto y Colón" sigue incompleta (la fecha no es numeración)',
      direccionIncompleta({ ...dirSolaCalles, direccion: 'Av. 10 de Agosto y Colon' }) === true,
    );
    caso(
      'dirección: con numeración o con referencia ya está completa',
      direccionIncompleta({ ...dirSolaCalles, direccion: 'Juan Montalvo 456 y Sucre' }) === false &&
        direccionIncompleta({ ...dirSolaCalles, referencia: 'frente a la farmacia' }) === false,
    );
    caso(
      'dirección: el retiro en agencia no dispara el candado',
      direccionIncompleta({ ...dirSolaCalles, entrega: 'agencia' }) === false,
    );
    caso(
      'dirección: repetir la misma calle NO reinicia el contador (bucle de 4 en la 1125)',
      intentosPedirReferencia(
        [
          { rol: 'ASISTENTE', texto: '🏙️ Dirección Exacta: calles, número de casa y una referencia' },
          { rol: 'CLIENTE', texto: 'Michael Ordonez, en la geovany calle' },
          { rol: 'ASISTENTE', texto: 'Solo me falta el número de casa y una referencia' },
          { rol: 'CLIENTE', texto: 'solo se que se llama geovany calle' },
          { rol: 'ASISTENTE', texto: '¿Me das el número de la casa o una referencia más clara?' },
          { rol: 'CLIENTE', texto: 'solo se que la calle se llama geovany calle' },
        ],
        'en la geovany calle',
      ) >= 2,
    );
    caso(
      'dirección: solo cuenta lo que el bot pidió DESPUÉS de la dirección',
      intentosPedirReferencia(
        [
          { rol: 'ASISTENTE', texto: '¿Tu dirección exacta (dos calles y una referencia)?' },
          { rol: 'CLIENTE', texto: 'Juan Montalvo y Sucre' },
          { rol: 'ASISTENTE', texto: '¿Me das el número de la casa y una referencia?' },
          { rol: 'CLIENTE', texto: 'ahi nomas' },
        ],
        'Juan Montalvo y Sucre',
      ) === 1,
    );
    caso(
      'dirección: 1ª vez se pide numeración; 2ª vez ya no se insiste',
      faltantesDir({ ...dirSolaCalles, _intentosDireccion: 0 }).some((x) => /numeraci/i.test(x)) &&
        !faltantesDir({ ...dirSolaCalles, _intentosDireccion: 1 }).some((x) => /numeraci/i.test(x)),
    );
    caso(
      'dirección: tras insistir, la ficha ofrece la agencia Servientrega',
      /agencia Servientrega más cercana/.test(
        bloqueDir({ ...dirSolaCalles, _intentosDireccion: 1 }, {}),
      ),
    );

    caso(
      'flujo: pasosDelFlujo respeta el switch usar_flujo_pasos',
      pasosDelFlujo({
        usar_flujo_pasos: 0,
        flujo_pasos_json: JSON.stringify([pasoEdad]),
      }).length === 0 &&
        pasosDelFlujo({
          usar_flujo_pasos: 1,
          flujo_pasos_json: JSON.stringify([pasoEdad]),
        }).length === 1,
    );
  }

  /* ── Bloque 15: resumen "x2" y precio del combo (caso 411, Aracelly, 2026-09-08) ──
     La clienta pidió "dos", el bot cerró "📦 Producto: Dr Melaxin x2" a $40 sin
     línea Cantidad; el sistema leyó cantidad 1 y cobró unitario x2 aunque el
     catálogo tiene combo de 2 por $25. */
  {
    console.log('\n── Bloque 15: cantidad en el renglón y precio del combo ──');
    const {
      parsearLineaProducto,
      corregirPrecioCombo,
    } = require('../src/utils/resumenPedido');
    const { parsearProductosResumen } = require('../src/services/kanban_ia.service');

    const l1 = parsearLineaProducto('Dr Melaxin x2');
    caso('renglón "Dr Melaxin x2" → cantidad 2 y nombre limpio', l1.cantidad === '2' && l1.producto === 'Dr Melaxin', JSON.stringify(l1));
    const l2 = parsearLineaProducto('2 x Reloj Steel Arabe');
    caso('renglón "2 x Reloj" → cantidad 2', l2.cantidad === '2' && l2.producto === 'Reloj Steel Arabe', JSON.stringify(l2));
    const l3 = parsearLineaProducto('*Dr Melaxin* (Variedad: Negro) x3');
    caso('renglón con variedad y x3', l3.cantidad === '3' && l3.variedad === 'Negro' && l3.producto === 'Dr Melaxin', JSON.stringify(l3));
    const l4 = parsearLineaProducto('Camisa Oversize x 2 unidades');
    caso('renglón "x 2 unidades"', l4.cantidad === '2' && l4.producto === 'Camisa Oversize', JSON.stringify(l4));
    const l5 = parsearLineaProducto('Aceite de Batana 100ml');
    caso('un "100ml" no es cantidad', l5.cantidad === '1' && l5.producto === 'Aceite de Batana 100ml', JSON.stringify(l5));
    const l6 = parsearLineaProducto('Dr Melaxin (x2)');
    caso('renglón "(x2)"', l6.cantidad === '2' && l6.producto === 'Dr Melaxin', JSON.stringify(l6));
    caso(
      'multi-producto sigue parseando igual (2 líneas → 2 renglones)',
      (() => {
        const r = parsearProductosResumen('📦 Producto: Reloj SKMEI x1\n📦 Producto: Reloj Steel x2 (Variedad: Negro)');
        return r.length === 2 && r[1].cantidad === '2' && r[1].variedad === 'Negro' && r[1].producto === 'Reloj Steel';
      })(),
    );

    const catalogo411 = [
      {
        id: 2018,
        nombre: 'Dr Melaxin',
        precio: '20.00',
        combos_producto: JSON.stringify([
          { cantidad: '1', precio: '20', id_dropi: '144476' },
          { cantidad: '2', precio: '25', id_dropi: '142847' },
          { cantidad: '3', precio: '30', id_dropi: '159920' },
        ]),
      },
      { id: 9, nombre: 'Onn Watch TV', precio: '35.00', combos_producto: '[]' },
    ];
    const resumen411 =
      'Todo está listo, Aracelly. Aquí está el resumen de tu pedido:\n' +
      '🧑 Nombre: Aracelly Lucas Solis\n📞 Teléfono: 0979500161\n📍 Provincia: Santa Elena\n' +
      '📍 Ciudad: Santa Elena\n🏡 Dirección: 10 de mayo Vinicio Yagual 1\n' +
      '📦 Producto: Dr Melaxin x2\n💰 Precio total: $40.00\n🚚 Envío: domicilio\n[generar_guia]:true';
    const c1 = await corregirPrecioCombo(resumen411, 411, { productos: catalogo411 });
    caso(
      'caso 411: "Dr Melaxin x2" a $40 → $25 (combo de 2)',
      !!c1 && c1.a === 25 && /Precio total: \$25\.00/.test(c1.texto) && !/\$40/.test(c1.texto),
      c1 ? c1.texto.slice(-120) : 'no corrigió',
    );
    caso(
      'con línea "🔢 Cantidad: 2" y "Producto: Dr Melaxin" también corrige',
      !!(await corregirPrecioCombo(
        resumen411.replace('Dr Melaxin x2', 'Dr Melaxin').replace('💰', '🔢 Cantidad: 2\n💰'),
        411,
        { productos: catalogo411 },
      )),
    );
    caso(
      'total ya correcto ($25) → no toca',
      (await corregirPrecioCombo(resumen411.replace('$40.00', '$25.00'), 411, { productos: catalogo411 })) === null,
    );
    caso(
      'total distinto por otra razón ($45, envío sumado) → no toca',
      (await corregirPrecioCombo(resumen411.replace('$40.00', '$45.00'), 411, { productos: catalogo411 })) === null,
    );
    caso(
      'una unidad → no toca',
      (await corregirPrecioCombo(resumen411.replace('Dr Melaxin x2', 'Dr Melaxin').replace('$40.00', '$20.00'), 411, { productos: catalogo411 })) === null,
    );
    caso(
      'producto sin combos → no toca',
      (await corregirPrecioCombo(resumen411.replace('Dr Melaxin x2', 'Onn Watch TV x2').replace('$40.00', '$70.00'), 411, { productos: catalogo411 })) === null,
    );
    caso(
      'resumen multi-producto → no toca (lo valida el auto-orden)',
      (await corregirPrecioCombo(resumen411.replace('📦 Producto: Dr Melaxin x2', '📦 Producto: Dr Melaxin x2\n📦 Producto: Onn Watch TV x1'), 411, { productos: catalogo411 })) === null,
    );
  }

  /* ── Bloque 16: guardia de listas de oficinas (caso 411, Santa Elena, 2026-09-08) ──
     gpt-4o-mini "ofreció" 3 oficinas de Santa Elena que no existen (la ciudad
     tiene UNA: Comercial Aguilar) sin que la clienta eligiera retiro. Toda
     lista del modelo se valida contra el directorio real. */
  {
    console.log('\n── Bloque 16: listas de oficinas validadas contra el directorio ──');
    const fs = require('fs');
    const R = require('../src/services/kanban_retiro_agencia.service');
    const oficinas = R.parseDirectorio(fs.readFileSync(R.RUTA_DEFAULT, 'utf8'));
    caso('directorio default parseado (≈597 oficinas)', oficinas.length > 500, String(oficinas.length));

    const lista411 =
      'En Santa Elena, puedes retirar tu pedido en una de las siguientes oficinas de Servientrega:\n' +
      '1. *Oficina Servientrega — Sector Centro*\n - Dirección: Av. León Febres-Cordero y Av. 10 de Agosto\n' +
      '2. *Oficina Servientrega — Sector La Libertad*\n - Dirección: Av. Manabí S/N y Av. Libertad\n' +
      '3. *Oficina Servientrega — Sector Salinas*\n - Dirección: Av. Malecón y Calle 38\n' +
      'Confirma cuál te queda mejor para poder avanzar con el pedido. 😊';
    caso('detecta los 3 ítems de la lista inventada', R.itemsOficinaEnRespuesta(lista411).length === 3, String(R.itemsOficinaEnRespuesta(lista411).length));
    caso('un mensaje normal no parece lista', R.itemsOficinaEnRespuesta('Perfecto! ¿A qué ciudad te lo enviamos? 📍').length === 0);
    caso('un resumen de cierre no parece lista', R.itemsOficinaEnRespuesta('🏡 Dirección: Av. Solano y Remigio Crespo\n📦 Producto: Dr Melaxin').length === 0);

    const fichaSE = { ciudad: 'Santa Elena', entrega: '', nombre: '', telefono: '', agencia: '', referencia: '', direccion: '' };
    const sinElegir = R.validarListaDelModelo({ respuesta: lista411, ficha: fichaSE, oficinas, mensajeCliente: 'Pero dónde son usted Yo soy en santa Elena' });
    caso(
      'caso 411: lista sin que eligiera retiro → pregunta de modalidad',
      !!sinElegir && sinElegir.texto.includes(R.GUARDIA_MARCA_MODALIDAD) && /Santa Elena/.test(sinElegir.texto),
      sinElegir ? sinElegir.texto : 'no intervino',
    );
    const conRetiro = R.validarListaDelModelo({ respuesta: lista411, ficha: { ...fichaSE, entrega: 'agencia' }, oficinas, mensajeCliente: 'en agencia' });
    caso(
      'con retiro elegido: la lista inventada se reemplaza por la real (Comercial Aguilar)',
      !!conRetiro && conRetiro.texto.includes(R.GUARDIA_MARCA_LISTA) && /GUAYAQUIL S\/N Y 9 OCTUBRE/.test(conRetiro.texto) && !/Febres/.test(conRetiro.texto),
      conRetiro ? conRetiro.texto : 'no intervino',
    );
    const eligeAhora = R.validarListaDelModelo({ respuesta: lista411, ficha: fichaSE, oficinas, mensajeCliente: 'prefiero retirar en agencia' });
    caso('el mensaje "prefiero retirar en agencia" cuenta como elección aunque la ficha no la traiga', !!eligeAhora && eligeAhora.texto.includes(R.GUARDIA_MARCA_LISTA));
    const listaReal = 'Perfecto! En Santa Elena tienes esta oficina:\n1) Sector Comercial Aguilar — Av. Guayaquil S/N y 9 de Octubre\n¿Retiramos ahí? 😊';
    caso(
      'lista REAL (dirección copiada, con "Av." y "de") se respeta',
      R.validarListaDelModelo({ respuesta: listaReal, ficha: { ...fichaSE, entrega: 'agencia' }, oficinas, mensajeCliente: 'agencia' }) === null,
    );
    const domicilio = R.validarListaDelModelo({ respuesta: lista411, ficha: { ...fichaSE, entrega: 'domicilio' }, oficinas, mensajeCliente: 'a domicilio' });
    caso('cliente que ya dijo domicilio → sigue con los datos, sin oficinas', !!domicilio && domicilio.texto.includes(R.GUARDIA_MARCA_DOMICILIO) && /nombre/.test(domicilio.texto));

    // Ciudad grande: primero el sector.
    const fichaCue = { ...fichaSE, ciudad: 'Cuenca', entrega: 'agencia' };
    const cuenca = R.decidirOfertaOficinas({ ficha: fichaCue, oficinas, mensajeCliente: 'en agencia' });
    caso('Cuenca (21 oficinas) sin referencia → pregunta el sector antes de listar', !!cuenca && cuenca.texto.includes(R.GUARDIA_MARCA_SECTOR), cuenca?.texto);
    const cuencaRef = R.decidirOfertaOficinas({ ficha: fichaCue, oficinas, mensajeCliente: 'cerca del Monay Shopping' });
    caso(
      'Cuenca con referencia "Monay" → lista directa, la coincidente primero',
      !!cuencaRef && cuencaRef.texto.includes(R.GUARDIA_MARCA_LISTA) && /MONAY/i.test(cuencaRef.texto.split('\n')[1]),
      cuencaRef?.texto,
    );
    const cuencaYaPidio = R.decidirOfertaOficinas({ ficha: fichaCue, oficinas, mensajeCliente: 'no sé, cualquiera', historialBot: [`Perfecto, retiro en Cuenca 😊 ${R.GUARDIA_MARCA_SECTOR}`] });
    caso('Cuenca, sector ya preguntado → lista de 5 sin volver a preguntar', !!cuencaYaPidio && cuencaYaPidio.texto.includes(R.GUARDIA_MARCA_LISTA) && cuencaYaPidio.texto.split('\n').filter((l) => /^\d\)/.test(l)).length === 5);
    const listaCuencaValida = cuencaRef ? cuencaRef.texto : '';
    caso(
      'Cuenca: lista real del modelo con referencia conocida se respeta',
      !!R.itemsOficinaEnRespuesta(listaCuencaValida).length &&
        R.validarListaDelModelo({ respuesta: listaCuencaValida, ficha: fichaCue, oficinas, mensajeCliente: 'cerca del Monay Shopping' }) === null,
    );
    const laLibertad = R.decidirOfertaOficinas({ ficha: { ...fichaSE, ciudad: 'La Libertad', entrega: 'agencia' }, oficinas, mensajeCliente: 'agencia' });
    caso('La Libertad (4 oficinas) → lista directa, sin pedir sector', !!laLibertad && laLibertad.texto.includes(R.GUARDIA_MARCA_LISTA) && laLibertad.texto.split('\n').filter((l) => /^\d\)/.test(l)).length === 4);
    caso('"Salinas" encuentra "SALINAS (SANTA ELENA)"', R.oficinasDeCiudad(oficinas, 'Salinas').length === 1 && R.oficinasDeCiudad(oficinas, 'Santa Elena').length === 1);

    // Ciudad fuera del directorio (Galápagos): referencia y luego por confirmar.
    const fichaGal = { ...fichaSE, ciudad: 'Puerto Ayora', entrega: 'agencia' };
    const g1 = R.validarListaDelModelo({ respuesta: lista411.replace(/Santa Elena/g, 'Puerto Ayora'), ficha: fichaGal, oficinas, mensajeCliente: 'agencia' });
    caso('ciudad fuera del directorio → pide referencia (no dice "no hay cobertura")', !!g1 && g1.texto.includes(R.GUARDIA_MARCA_REFERENCIA) && !/no hay|cobertura/i.test(g1.texto), g1?.texto);
    const g2 = R.validarListaDelModelo({ respuesta: lista411.replace(/Santa Elena/g, 'Puerto Ayora'), ficha: fichaGal, oficinas, mensajeCliente: 'la del muelle', historialBot: [g1?.texto || ''] });
    caso('segunda vez → avanza con "por confirmar" y pide el dato que falta', !!g2 && g2.texto.includes(R.GUARDIA_MARCA_PORCONFIRMAR) && /muelle/.test(g2.texto) && /nombre/.test(g2.texto), g2?.texto);

    // E2E cfg 610 (2026-09-08): gpt-5-mini listó oficinas REALES de La Libertad
    // y Ancón como si fueran de Santa Elena, con un encabezado que termina en
    // "¿cuál te queda mejor?". El encabezado no es un ítem; los 4 sí, y son de
    // otra ciudad → se reemplazan por la única real de Santa Elena.
    const listaOtraCiudad =
      'Perfecto! En Santa Elena puedes retirar en estas oficinas Servientrega — ¿cuál te queda mejor? 😊\n\n' +
      '- Sector Barrio 28 De Mayo — DIAGONAL AL SHOPPING LA LIBERTAD BARRIO 28 DE MAYO AV. 12 38 E./ CALLES 11 Y 12 FRENTE A RESTAURANT SAN SEBASTIAN\n' +
      '- Sector Eleodoro Solorzano — AV ELEODORO SOLORZANO ENTRE CALLE 21-22 DIAGONAL AL PARQUE DE LOS HAMBRIENTOS, FRENTE A PERNIACERO.\n' +
      '- Sector Jose Tamariz Mora — BARRIO JOSE TAMARIZ MORA AV 6TA Y CALLE 32\n' +
      '- Sector Barrio Central (ANCÓN) — BARRIO CENTRAL DIAGONAL UPC ZONA CENTRICA';
    caso('el encabezado con "¿cuál…?" no cuenta como ítem (4 ítems, no 5)', R.itemsOficinaEnRespuesta(listaOtraCiudad).length === 4, String(R.itemsOficinaEnRespuesta(listaOtraCiudad).length));
    const otraCiudad = R.validarListaDelModelo({ respuesta: listaOtraCiudad, ficha: { ...fichaSE, entrega: 'agencia' }, oficinas, mensajeCliente: 'en agencia' });
    caso('oficinas reales pero de OTRA ciudad (La Libertad/Ancón) → se reemplazan por la de Santa Elena', !!otraCiudad && /GUAYAQUIL S\/N Y 9 OCTUBRE/.test(otraCiudad.texto) && !/LIBERTAD/.test(otraCiudad.texto), otraCiudad?.texto);

    // E2E cfg 610 (2026-09-08): tras la lista del modelo ("¿Cuál eliges?") y
    // la confirmación "retiras en …", al pedir el teléfono la guardia volvía a
    // listar. Una lista del modelo o una confirmación ya cuentan como oferta.
    const listaModeloCuenca =
      'Perfecto — te dejo las oficinas cerca del *Monay Shopping* en Cuenca:\n' +
      '1) Sector Av. Gonzalez Suarez - Monay — AV. GONZALEZ SUAREZ S/N Y PANCHO VILLA 1 REF A UNA CUADRA DEL MONAY SHOPPING\n' +
      '2) Sector Av. Gil Ramirez Davalos — AV.GIL RAMIREZ DAVALOS Y FRANCISCO PIZARRO N3-89 FRENTE A LA GASOLINERA PYS\n¿Cuál eliges? 😊';
    caso('una lista del propio modelo cuenta como "ya ofreció"', R.yaOfrecioOficinas(['Gracias!', listaModeloCuenca]));
    caso('la confirmación "retiras en …" cuenta como oficina resuelta', R.yaOfrecioOficinas(['Perfecto, retiras en Av. Gonzalez Suarez - Monay — AV. GONZALEZ SUAREZ S/N 😊 ¿Tu nombre completo?']));
    caso('sin listas ni confirmaciones → no ofreció', !R.yaOfrecioOficinas(['¿A qué ciudad te lo enviamos? 📍', `Perfecto, retiro en Cuenca 😊 ${R.GUARDIA_MARCA_SECTOR}`]));

    caso('"¿puedo retirar en agencia?" NO es elegir retiro', !R.eligeRetiroEnMensaje('¿puedo retirar en agencia?') && !R.eligeRetiroEnMensaje('hay agencia en Loja'));
    caso('"en agencia" / "retiro en oficina" SÍ es elegir retiro', R.eligeRetiroEnMensaje('en agencia') && R.eligeRetiroEnMensaje('retiro en oficina servientrega') && !R.eligeRetiroEnMensaje('a domicilio'));
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
    // El prompt vigente de la 285 deriva el cambio de producto al asesor, a
    // veces nombrando la licuadora y a veces no. Ambas cosas son "el cambio
    // se reconoció"; la garantía dura de este caso es el prohibido (que el
    // ancla no lo arrastre al producto del incidente).
    requerido: /licuadora|asesor/i,
  },
  {
    // La 818 es inmobiliaria: se agenda la VISITA al inmueble desde
    // por_agendar (el guion laser de cuando era estética ya no aplica ahí).
    nombre: 'servicios 818: agendar visita no se rompe',
    args: [String(CFG_SERVICIOS), String(CLIENTE_SERVICIOS), '--desde=por_agendar', '--guion=visita'],
    prohibido: /depilaci|l[aá]ser|error|exception/i,
    requerido: /visita|agend|solicitud/i,
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
