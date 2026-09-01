// services/producto_wizard_runtime.service.js
// Lo que el wizard de producto hace EN VIVO cuando escribe un cliente:
//
//  1. intentarMensajeFijoWizard — el cliente llega desde un anuncio, el
//     resolver identifica el producto y ese producto tiene wizard activo →
//     se manda el PAQUETE FIJO (hasta 3 imágenes + 1 video + mensaje_inicial)
//     sin pasar por ningún modelo. Si además el mensaje fue un saludo o un
//     "quiero info", el turno termina ahí (0 tokens).
//  2. intentarRespuestaRapida — en los turnos siguientes, si la pregunta del
//     cliente calza con una respuesta quemada del producto en juego, se manda
//     esa (0 tokens). Si no calza, el turno sigue a la IA.
//  3. wizardParaMotor — la ficha enriquecida del producto (descripción IA,
//     bullets, FAQs, precios y stock EN VIVO) que la IA recibe del turno 2 en
//     adelante. La consume kanban_ia.service.js. El modelo NO se decide acá:
//     es el de la columna del kanban (kanban_columnas.modelo).
//
// Radio de impacto: todo está gateado por "producto con wizard_completado=1 y
// activo=1". Las cuentas que no configuren nada no pasan por acá.

const { db } = require('../database/config');
const ProductosWizard = require('../models/productos_wizard.model');
const {
  resolverProductoAnuncio,
} = require('../utils/webhook_whatsapp/buscar_producto_referral');
const {
  enviarMedioWhatsapp,
} = require('../utils/webhook_whatsapp/enviarMultimedia');
const {
  enviarMensajeWhatsapp,
} = require('../utils/webhook_whatsapp/enviarMensajes');
const {
  filtrarMediaNueva,
  olvidarEnviado,
  ofrecerMedia,
} = require('../utils/dedupeMedia');
const {
  leerJson,
  combosValidos,
  fmtPrecio,
  paqueteMedia,
  componerMensajeInicial,
} = require('../utils/wizardProducto/componerMensajeInicial');
const {
  esSaludoOGenerico,
  pareceIntencionCompra,
  esSaludoDeAnuncio,
  pareceRegunta,
  elegirRespuestaRapida,
} = require('../utils/wizardProducto/respuestasRapidas');
const { resolverUpsell, directivaUpsell } = require('../utils/upsellProducto');

// Responsables distintos para que el chat muestre qué salió sin IA: el
// paquete fijo y las respuestas rápidas. ('IA_wizard' queda como legado.)
const RESPONSABLE = 'IA_mensaje_fijo';
const RESPONSABLE_FIJO = 'IA_mensaje_fijo';
const RESPONSABLE_RAPIDA = 'IA_respuesta_rapida';
const RESPONSABLE_FLUJO = 'IA_flujo_venta';
const RESPONSABLES_SIN_IA = [
  'IA_wizard',
  RESPONSABLE_FIJO,
  RESPONSABLE_RAPIDA,
  RESPONSABLE_FLUJO,
];
const VENTANA_REENVIO_HORAS = 48;

// Cache corto del wizard por producto: el webhook lo consulta en cada mensaje
// de cada cliente del anuncio. 60 s alcanza para no pegarle a la BD en ráfaga
// y para que un cambio desde el panel se vea casi al instante.
const CACHE_WIZARD = new Map();
const CACHE_TTL_MS = 60 * 1000;

function logDe(log) {
  return typeof log === 'function' ? log : async () => {};
}

/* ══════════════════════════════════════════════════════════════
   Lectura
   ══════════════════════════════════════════════════════════════ */

async function wizardActivoDeProducto(id_producto) {
  const clave = String(id_producto);
  const hit = CACHE_WIZARD.get(clave);
  if (hit && Date.now() - hit.ts < CACHE_TTL_MS) return hit.wizard;

  let wizard = null;
  try {
    const fila = await ProductosWizard.findOne({
      where: { id_producto, wizard_completado: 1, activo: 1 },
    });
    wizard = fila ? fila.toJSON() : null;
  } catch {
    wizard = null;
  }
  CACHE_WIZARD.set(clave, { wizard, ts: Date.now() });
  if (CACHE_WIZARD.size > 5000) {
    const limite = Date.now() - CACHE_TTL_MS;
    for (const [k, v] of CACHE_WIZARD) if (v.ts < limite) CACHE_WIZARD.delete(k);
  }
  return wizard;
}

/** Invalida la cache (la llama el servicio al guardar desde el panel). */
function olvidarWizard(id_producto) {
  if (id_producto) CACHE_WIZARD.delete(String(id_producto));
  else CACHE_WIZARD.clear();
}

/**
 * Producto del anuncio + su wizard activo. Devuelve null si el anuncio no se
 * resuelve o si el producto no tiene wizard completado.
 */
/* Variedades + upsell del producto, para que la ficha del motor los conozca.
   Compartido entre la resolución por anuncio y la resolución por texto. */
async function enriquecerProductoWizard(producto) {
  try {
    const [fila] = await db.query(
      `SELECT es_variable FROM productos_chat_center WHERE id = ? LIMIT 1`,
      { replacements: [producto.id], type: db.QueryTypes.SELECT },
    );
    producto.es_variable = Number(fila?.es_variable) === 1 ? 1 : 0;
    producto.variaciones = producto.es_variable
      ? await db.query(
          `SELECT atributo, valor, stock, precio_sugerido
             FROM productos_variaciones
            WHERE id_producto = ? AND activo = 1 ORDER BY id`,
          { replacements: [producto.id], type: db.QueryTypes.SELECT },
        )
      : [];
  } catch {
    producto.variaciones = [];
  }
  // Upsell configurado (referencia a otro producto o campos legacy).
  try {
    producto.upsell = await resolverUpsell(producto);
  } catch {
    producto.upsell = null;
  }
  return producto;
}

async function resolverWizardDelAnuncio(id_configuracion, headline, source_id) {
  const r = await resolverProductoAnuncio(id_configuracion, headline, source_id);
  if (!r?.producto) return null;
  const wizard = await wizardActivoDeProducto(r.producto.id);
  if (!wizard) return null;
  await enriquecerProductoWizard(r.producto);
  return { producto: r.producto, wizard, via: r.via };
}

/* ── Resolución por TEXTO (cliente sin anuncio) ──
   Si el mensaje nombra sin ambigüedad un producto que TIENE bot configurado,
   el flujo del wizard aplica igual que si viniera del anuncio. Si el nombre no
   se identifica con confianza (cobertura baja o dos productos que calzan), se
   devuelve null y el bot sigue el flujo normal con IA. */
const STOPWORDS_NOMBRE = new Set([
  'de', 'del', 'la', 'las', 'el', 'los', 'un', 'una', 'unos', 'unas', 'para',
  'con', 'sin', 'por', 'en', 'y', 'o', 'u', 'a', 'al', 'tu', 'su', 'mas',
]);

const normalizarPalabras = (s) =>
  String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9ñ\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);

const CACHE_LISTA_WIZARD = new Map();
async function productosConWizard(id_configuracion) {
  const clave = String(id_configuracion);
  const hit = CACHE_LISTA_WIZARD.get(clave);
  if (hit && Date.now() - hit.ts < CACHE_TTL_MS) return hit.lista;
  let lista = [];
  try {
    lista = await db.query(
      `SELECT p.id, p.nombre
         FROM productos_chat_center p
         JOIN productos_wizard w
           ON w.id_producto = p.id AND w.wizard_completado = 1 AND w.activo = 1
        WHERE p.id_configuracion = ? AND p.eliminado = 0`,
      { replacements: [id_configuracion], type: db.QueryTypes.SELECT },
    );
  } catch {
    lista = [];
  }
  CACHE_LISTA_WIZARD.set(clave, { lista, ts: Date.now() });
  return lista;
}

function elegirProductoPorTexto(mensaje, lista) {
  const palabrasMsg = new Set(normalizarPalabras(mensaje));
  if (!palabrasMsg.size) return null;

  let mejor = null;
  let mejorCobertura = 0;
  let empate = false;
  for (const p of lista) {
    const sig = normalizarPalabras(p.nombre).filter(
      (w) => w.length >= 3 && !STOPWORDS_NOMBRE.has(w),
    );
    if (!sig.length) continue;
    const aciertos = sig.filter((w) => palabrasMsg.has(w)).length;
    const cobertura = aciertos / sig.length;
    // Con una sola palabra significativa se exige la palabra completa y larga
    // ("cabeza" nunca debe calzar con "Cabezal"); con dos o más, 60% de
    // cobertura mínimo ("el cargador" solo, no basta para "cargador de
    // bateria": podría ser cualquier cargador del catálogo). Excepción: si el
    // cliente nombró el ARRANQUE del nombre —las dos primeras palabras
    // significativas—, identifica aunque el nombre completo sea largo (caso
    // real 782: "quiero el army bomb" para "ARMY BOMB LIGTHSTICK BTS V4" era
    // 2/4 = 50% y el paquete no salía). Dos productos que arranquen igual
    // siguen cayendo al desempate por cobertura / empate → IA.
    const calza =
      sig.length === 1
        ? aciertos === 1 && sig[0].length >= 4
        : cobertura >= 0.6 ||
          (palabrasMsg.has(sig[0]) && palabrasMsg.has(sig[1]));
    if (!calza) continue;
    if (cobertura > mejorCobertura) {
      mejor = p;
      mejorCobertura = cobertura;
      empate = false;
    } else if (cobertura === mejorCobertura && mejor && p.id !== mejor.id) {
      empate = true;
    }
  }
  return empate ? null : mejor;
}

async function resolverWizardPorTexto(id_configuracion, mensaje) {
  const lista = await productosConWizard(id_configuracion);
  if (!lista.length) return null;
  const elegido = elegirProductoPorTexto(mensaje, lista);
  if (!elegido) return null;
  const wizard = await wizardActivoDeProducto(elegido.id);
  if (!wizard) return null;
  const [producto] = await db.query(
    `SELECT id, id_configuracion, nombre, descripcion, precio, imagen_url,
            video_url, combos_producto, stock, id_producto_upsell,
            nombre_upsell, descripcion_upsell, precio_upsell, imagen_upsell_url
       FROM productos_chat_center
      WHERE id = ? LIMIT 1`,
    { replacements: [elegido.id], type: db.QueryTypes.SELECT },
  );
  if (!producto) return null;
  await enriquecerProductoWizard(producto);
  return { producto, wizard, via: 'texto' };
}

/* Ancla el producto identificado por texto como "producto en juego" del
   cliente (cliente_productos_ad con headline = nombre del producto). Así los
   turnos siguientes —respuestas rápidas, ficha del motor, ancla del
   contexto— funcionan igual que si hubiera entrado por el anuncio. */
async function sembrarProductoEnJuego({
  id_cliente,
  id_configuracion,
  producto,
  texto_mensaje,
}) {
  try {
    const [ultimo] = await db.query(
      `SELECT headline FROM cliente_productos_ad
        WHERE id_cliente = ? ORDER BY id DESC LIMIT 1`,
      { replacements: [id_cliente], type: db.QueryTypes.SELECT },
    );
    if (String(ultimo?.headline || '') === String(producto.nombre)) return;
    await db.query(
      `INSERT INTO cliente_productos_ad
         (id_cliente, id_configuracion, headline, body_ad, source_url, source_id, ctwa_clid, mensaje_cliente)
       VALUES (?, ?, ?, NULL, NULL, NULL, NULL, ?)`,
      {
        replacements: [
          id_cliente,
          id_configuracion,
          producto.nombre,
          String(texto_mensaje || '').slice(0, 500),
        ],
        type: db.QueryTypes.INSERT,
      },
    );
  } catch {
    /* sin ancla no se rompe nada: el turno actual ya resolvió por texto */
  }
}

/**
 * El producto "en juego" del cliente para las respuestas rápidas: el del
 * último anuncio por el que entró (cliente_productos_ad). Es la misma fuente
 * que usa kanban_ia para reinyectar el producto, así no se contradicen.
 */
async function wizardDelClienteEnJuego(id_configuracion, id_cliente) {
  try {
    const [ad] = await db.query(
      `SELECT headline, source_id FROM cliente_productos_ad
        WHERE id_cliente = ? AND id_configuracion = ?
        ORDER BY id DESC LIMIT 1`,
      {
        replacements: [id_cliente, id_configuracion],
        type: db.QueryTypes.SELECT,
      },
    );
    if (!ad) return null;
    return await resolverWizardDelAnuncio(
      id_configuracion,
      ad.headline,
      ad.source_id,
    );
  } catch {
    return null;
  }
}

/**
 * El bot tiene que estar encendido para la cuenta (openai_assistants.activo)
 * y para la columna del cliente (kanban_columnas.activa_ia). Si el negocio
 * apagó el bot o la columna es humana, ni el paquete ni la quemada salen:
 * el mensaje fijo es parte del bot, no un automatizador aparte.
 */
async function botHabilitado(id_configuracion, estado_contacto) {
  try {
    const [sw] = await db.query(
      `SELECT activo FROM openai_assistants
        WHERE id_configuracion = ? AND tipo = 'ventas' AND deleted_at IS NULL
        LIMIT 1`,
      { replacements: [id_configuracion], type: db.QueryTypes.SELECT },
    );
    if (!sw || Number(sw.activo) !== 1) return false;

    if (estado_contacto) {
      const [col] = await db.query(
        `SELECT activa_ia FROM kanban_columnas
          WHERE id_configuracion = ? AND LOWER(estado_db) = LOWER(?)
            AND activo = 1
          LIMIT 1`,
        {
          replacements: [id_configuracion, estado_contacto],
          type: db.QueryTypes.SELECT,
        },
      );
      if (col && Number(col.activa_ia) !== 1) return false;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * ¿Ya se le mandó ESTE mensaje inicial a este cliente hace poco? Se compara
 * el texto exacto del mensaje fijo dentro de la ventana de 48 h (la misma
 * que dedupeMedia), y se respeta el reinicio de conversación si la columna
 * existe. Así una re-entrada desde el mismo anuncio días después vuelve a
 * recibir el paquete, pero un doble click o un segundo "hola" no.
 */
async function yaSeEnvioMensajeInicial({
  id_configuracion,
  id_cliente,
  mensaje_inicial,
}) {
  if (!mensaje_inicial) return false;
  try {
    const [fila] = await db.query(
      `SELECT m.id FROM mensajes_clientes m
        WHERE m.id_configuracion = ? AND m.celular_recibe = ?
          AND m.responsable IN ('IA_wizard', 'IA_mensaje_fijo') AND m.tipo_mensaje = 'text'
          AND m.texto_mensaje = ?
          AND m.created_at >= DATE_SUB(NOW(), INTERVAL ${VENTANA_REENVIO_HORAS} HOUR)
          AND m.created_at >= COALESCE(
                (SELECT c.reinicio_conversacion_at FROM clientes_chat_center c
                  WHERE c.id = ? LIMIT 1),
                '1970-01-01')
        ORDER BY m.id DESC LIMIT 1`,
      {
        replacements: [
          id_configuracion,
          String(id_cliente),
          mensaje_inicial,
          id_cliente,
        ],
        type: db.QueryTypes.SELECT,
      },
    );
    return Boolean(fila);
  } catch {
    // Sin la columna de reinicio (BD vieja) se repite sin ese filtro.
    try {
      const [fila] = await db.query(
        `SELECT id FROM mensajes_clientes
          WHERE id_configuracion = ? AND celular_recibe = ?
            AND responsable IN ('IA_wizard', 'IA_mensaje_fijo') AND tipo_mensaje = 'text'
            AND texto_mensaje = ?
            AND created_at >= DATE_SUB(NOW(), INTERVAL ${VENTANA_REENVIO_HORAS} HOUR)
          LIMIT 1`,
        {
          replacements: [
            id_configuracion,
            String(id_cliente),
            mensaje_inicial,
          ],
          type: db.QueryTypes.SELECT,
        },
      );
      return Boolean(fila);
    } catch {
      return false;
    }
  }
}

/* ══════════════════════════════════════════════════════════════
   Envío
   ══════════════════════════════════════════════════════════════ */

/**
 * Manda el paquete fijo: imágenes, video y después el texto. La media pasa
 * por filtrarMediaNueva (único dedupe de fotos del sistema) y se marca como
 * ofrecida para que el candado de propiedad no la frene.
 */
async function enviarPaqueteInicial({
  id_configuracion,
  id_cliente,
  telefono,
  business_phone_id,
  accessToken,
  producto,
  wizard,
  log,
  // true = el texto sale SIN la pregunta gancho (la usa la derivación al
  // producto alterno cuando la respuesta al gancho ya se conoce — p. ej. la
  // edad heredada — para no preguntarla dos veces).
  omitirGancho = false,
}) {
  const decir = logDe(log);
  const { imagenes, videos } = paqueteMedia({ producto, wizard });
  let texto =
    String(wizard.mensaje_inicial || '').trim() ||
    componerMensajeInicial({ producto, wizard });
  const gancho = String(wizard.pregunta_gancho || '').trim();
  if (omitirGancho && gancho && texto.includes(gancho)) {
    texto = texto.split(gancho).join('').trim();
  }

  ofrecerMedia(
    id_cliente,
    [...imagenes, ...videos].map((m) => m.url),
  );

  const imgsNuevas = await filtrarMediaNueva({
    id_cliente,
    id_configuracion,
    urls: imagenes.map((m) => m.url),
    etiqueta: 'imagen wizard',
    log: decir,
  });
  const vidsNuevos = await filtrarMediaNueva({
    id_cliente,
    id_configuracion,
    urls: videos.map((m) => m.url),
    etiqueta: 'video wizard',
    log: decir,
  });

  let enviados = 0;
  const mandarMedia = async (tipo, url) => {
    const r = await enviarMedioWhatsapp({
      tipo,
      url_archivo: url,
      phone_whatsapp_to: telefono,
      business_phone_id,
      accessToken,
      id_configuracion,
      responsable: RESPONSABLE,
    });
    if (!r?.ok) {
      olvidarEnviado(id_cliente, url);
      await decir(`⚠️ wizard: falló ${tipo} ${url}: ${r?.error?.message || r?.error || ''}`);
      return;
    }
    enviados += 1;
  };

  for (const url of imgsNuevas) await mandarMedia('image', url);
  for (const url of vidsNuevos) await mandarMedia('video', url);

  /* El texto SIEMPRE debe llegar después de los adjuntos. El envío ya es
     secuencial, pero Meta procesa la media (descarga/transcodifica) y un texto
     despachado enseguida puede llegarle al teléfono ANTES que la última
     imagen. La pausa le da ventaja a la media; 2 s no se notan en un primer
     mensaje con fotos. */
  if (enviados > 0 && texto) {
    await new Promise((r) => setTimeout(r, 2000));
  }

  if (texto) {
    await enviarMensajeWhatsapp({
      phone_whatsapp_to: telefono,
      texto_mensaje: texto,
      business_phone_id,
      accessToken,
      id_configuracion,
      responsable: RESPONSABLE,
      total_tokens: 0,
    });
    enviados += 1;
  }

  await decir(
    `📦 wizard: paquete fijo enviado (producto ${producto.id} "${producto.nombre}", ${imgsNuevas.length} img, ${vidsNuevos.length} video, texto ${texto ? 'sí' : 'no'})`,
  );
  return { enviados, imagenes: imgsNuevas.length, videos: vidsNuevos.length };
}

/* Cierre de venta al ENVIAR una respuesta rápida: si no termina preguntando,
   se le añade el remate (una sola fuente, compartida con el simulador). */
const {
  conCierreDeVenta,
  semillaCierre,
} = require('../utils/wizardProducto/cierreVenta');

async function enviarTextoWizard({
  id_configuracion,
  telefono,
  business_phone_id,
  accessToken,
  texto,
  responsable = RESPONSABLE_RAPIDA,
}) {
  await enviarMensajeWhatsapp({
    phone_whatsapp_to: telefono,
    texto_mensaje: texto,
    business_phone_id,
    accessToken,
    id_configuracion,
    responsable,
    total_tokens: 0,
  });
}

/* ══════════════════════════════════════════════════════════════
   Bloque para el motor (turno 2+)
   ══════════════════════════════════════════════════════════════ */

/**
 * Ficha del producto para la IA: lo que el negocio configuró + precio, combos
 * y stock leídos EN VIVO de productos_chat_center. Sin URLs de media a
 * propósito (las fotos ya salieron en el paquete y el dedupe las frena).
 */
function bloqueWizardParaMotor({ producto, wizard }, { hayCatalogo = true } = {}) {
  const combos = combosValidos(producto.combos_producto);
  const bullets = leerJson(wizard.bullets_json, []);
  const faqs = leerJson(wizard.respuestas_rapidas_json, []).filter(
    (f) => f && f.activa !== 0 && f.pregunta && f.respuesta,
  );
  const stock = Number(producto.stock);
  const sinStock = Number.isFinite(stock) && stock <= 0;

  const hayVariedades =
    Array.isArray(producto.variaciones) && producto.variaciones.length > 0;
  const lineas = [];
  lineas.push(
    `⚠️ REGLA PRIORITARIA (manda sobre cualquier guion, fase o mensaje numerado de abajo):`,
  );
  lineas.push(
    wizard.tipo_venta === 'servicio'
      ? `La fase de PRESENTACIÓN de este servicio YA FUE COMPLETADA por el sistema: el cliente recibió fotos, precio y la pregunta de cierre en un mensaje fijo. No saludes de nuevo ni vuelvas a presentarlo. Sigue tu guion desde el punto posterior a la presentación SIN SALTARTE ningún dato que tu guion pida (ciudad o sede, fecha, horario, datos del cliente): pregunta lo que todavía no sepas, en el orden de tu guion, una pregunta por mensaje.`
      : `La fase de PRESENTACIÓN de este producto YA FUE COMPLETADA por el sistema: el cliente recibió fotos, precio${combos.length ? ', combos' : ''} y la pregunta de cierre en un mensaje fijo. No saludes de nuevo, no vuelvas a presentar el producto ni repitas precios que no te pidan. Sigue tu guion desde el punto posterior a la presentación SIN SALTARTE ningún dato que tu guion pida (ciudad, cantidad${hayVariedades ? ', variedad' : ''}, tipo de envío, nombre, teléfono, dirección u oficina): pregunta lo que todavía no sepas, en el orden de tu guion, una pregunta por mensaje. Nunca deduzcas la ciudad de una dirección: si el cliente no la dijo, pregúntala.`,
  );
  lineas.push('');
  lineas.push(
    `[PRODUCTO EN JUEGO — configurado por el negocio, datos EN VIVO]`,
  );
  const esServicio = wizard.tipo_venta === 'servicio';
  lineas.push(`🛒 ${esServicio ? 'Servicio' : 'Producto'}: ${producto.nombre}`);
  lineas.push(
    `💵 Precio${esServicio ? '' : ' unitario'}: ${fmtPrecio(producto.precio)}`,
  );
  if (esServicio) {
    lineas.push(`Es un SERVICIO: no hables de unidades, envío ni "pagas al recibir"; el cierre es agendar (fecha, horario, sede).`);
  } else if (combos.length) {
    lineas.push(
      `🔥 Combos válidos: ${combos
        .map((c) => `${c.cantidad} por ${fmtPrecio(c.precio)}`)
        .join(' · ')}`,
    );
  } else {
    lineas.push(`Combos: NO hay. Nunca menciones la palabra "combo".`);
  }
  if (Number.isFinite(stock)) {
    lineas.push(
      sinStock
        ? `📦 Stock: AGOTADO. No lo ofrezcas ni tomes el pedido; ofrece avisar cuando vuelva.`
        : `📦 Stock disponible: ${stock}`,
    );
  }
  if (hayVariedades) {
    lineas.push(
      `🎨 Variedades (el cliente debe elegir una): ${producto.variaciones
        .map(
          (v) =>
            `${v.atributo ? `${v.atributo} ` : ''}${v.valor}${v.stock != null ? ` (stock ${v.stock})` : ''}`,
        )
        .join(' · ')}`,
    );
  }
  // Una sola descripción: la del catálogo (la IA del wizard escribe ahí).
  const descripcion = String(
    producto.descripcion || wizard.descripcion_ia || '',
  ).trim();
  if (descripcion) lineas.push(`📃 Descripción: ${descripcion}`);
  if (Array.isArray(bullets) && bullets.length) {
    lineas.push(`✅ Beneficios: ${bullets.join(' · ')}`);
  }
  if (faqs.length) {
    lineas.push(`❓ Preguntas frecuentes (responde con esto, textual si aplica):`);
    for (const f of faqs.slice(0, 12)) {
      lineas.push(`- ${f.pregunta} → ${f.respuesta}`);
    }
  }
  // Upsell configurado: la oferta única tras la confirmación de compra. Sin
  // upsell no se agrega nada y el bot no ofrece ni cierra con productos extra.
  if (!esServicio && producto.upsell) {
    lineas.push(directivaUpsell(producto.upsell));
  }
  lineas.push('');
  lineas.push(
    `INSTRUCCIÓN: Responde puntual lo que pregunte usando SOLO estos datos (precios, stock, combos y variedades de arriba son la verdad actual) y avanza hacia los datos de cierre sin repetir las fotos. ${
      wizard.tipo_venta === 'natural_salud'
        ? 'Este producto es natural/salud: nunca digas que cura, trata o previene enfermedades; usa "ayuda a" o "alivia la molestia". ' +
          'Las preguntas normales (para qué sirve, cómo se usa o se toma, si ayuda con su molestia) respóndelas con seguridad usando esta ficha y cierra la venta: NO mandes al cliente a "consultar con su médico" por preguntar eso. ' +
          'Recomienda atención médica ÚNICAMENTE si menciona una emergencia o algo serio (síntomas graves, embarazo, cirugía reciente, medicación delicada). '
        : ''
    }${
      hayCatalogo
        ? 'Si pregunta por CUALQUIER OTRO producto, usa tu catálogo normalmente.'
        : // Sin catálogo a la vista (Fase 3: la ficha apagó el file_search y no
          // hay inline), "usa tu catálogo" era invitar a inventar precios.
          'Si pregunta por CUALQUIER OTRO producto que no esté en esta ficha, no inventes precios ni datos: dile que un asesor le confirma esa información y sigue con este pedido.'
    }`,
  );
  return lineas.join('\n');
}

/**
 * Para kanban_ia: ficha del producto del anuncio con wizard, o null.
 */
async function wizardParaMotor(id_configuracion, headline, source_id) {
  try {
    const r = await resolverWizardDelAnuncio(id_configuracion, headline, source_id);
    if (!r) return null;
    return {
      bloque: bloqueWizardParaMotor(r),
      id_producto: r.producto.id,
    };
  } catch {
    return null;
  }
}

/* ══════════════════════════════════════════════════════════════
   Puntos de entrada del webhook
   ══════════════════════════════════════════════════════════════ */

/**
 * Primer contacto desde un anuncio.
 * @returns {{ paqueteEnviado:boolean, saltarIA:boolean, bloqueMotor:string|null }}
 */
async function intentarMensajeFijoWizard({
  id_configuracion,
  id_cliente,
  telefono,
  business_phone_id,
  accessToken,
  estado_contacto,
  referral,
  texto_mensaje,
  log,
}) {
  const nada = { paqueteEnviado: false, saltarIA: false, bloqueMotor: null };
  const decir = logDe(log);

  let r = null;
  if (referral) {
    r = await resolverWizardDelAnuncio(
      id_configuracion,
      referral.headline || '',
      referral.source_id || null,
    );
  } else {
    // Sin anuncio: si el mensaje nombra sin ambigüedad un producto con bot
    // configurado, el flujo aplica igual. Si no se identifica con confianza,
    // r queda null y el bot sigue el flujo normal con IA.
    r = await resolverWizardPorTexto(id_configuracion, texto_mensaje);
    if (r) {
      await decir(
        `wizard: producto identificado por TEXTO → "${r.producto.nombre}" (id ${r.producto.id})`,
      );
      await sembrarProductoEnJuego({
        id_cliente,
        id_configuracion,
        producto: r.producto,
        texto_mensaje,
      });
    }
  }
  if (!r) return nada;

  const { producto, wizard } = r;
  const bloqueMotor = bloqueWizardParaMotor(r);

  if (!(await botHabilitado(id_configuracion, estado_contacto))) {
    await decir(`wizard: bot apagado para config ${id_configuracion}; no mando paquete`);
    return { ...nada, bloqueMotor };
  }

  const textoFijo =
    String(wizard.mensaje_inicial || '').trim() ||
    componerMensajeInicial({ producto, wizard });

  if (
    await yaSeEnvioMensajeInicial({
      id_configuracion,
      id_cliente,
      mensaje_inicial: textoFijo,
    })
  ) {
    await decir(`wizard: paquete ya enviado hace <${VENTANA_REENVIO_HORAS}h; sigue la IA`);
    return { ...nada, bloqueMotor };
  }

  await enviarPaqueteInicial({
    id_configuracion,
    id_cliente,
    telefono,
    business_phone_id,
    accessToken,
    producto,
    wizard,
    log: decir,
  });

  // Con flujo de pasos configurado, el embudo arranca junto al paquete: el
  // paso 0 queda esperando la respuesta a la pregunta gancho.
  const pasosFlujo = pasosDelFlujo(wizard);
  if (pasosFlujo.length) {
    await iniciarFlujoPasos({
      id_configuracion,
      id_cliente,
      id_producto: producto.id,
      estado_contacto,
    });
    await decir(`🪜 flujo: iniciado (${pasosFlujo.length} pasos) producto ${producto.id}`);
  }

  /* ¿Hace falta la IA en este turno?
     Regla ESTRUCTURAL (no de lista de palabras): el paquete ya presenta el
     producto, sus precios/combos, el envío y cierra preguntando. Después de
     enviarlo, la IA solo entra si el mensaje trae algo que el paquete NO
     responde:
       1. Calza con una respuesta rápida → se contesta la quemada (0 tokens).
       2. Es intención de compra ("quiero 2", "dale el combo") → IA, a cerrar.
       3. Es una pregunta real que las quemadas no cubren → IA con la ficha.
       4. TODO lo demás (saludos, "quiero info", typos, relleno, stickers de
          texto) → el paquete ES la respuesta: turno cerrado sin IA. */
  const texto = String(texto_mensaje || '');

  if (Number(wizard.usar_respuestas_rapidas) === 1) {
    const faqs = leerJson(wizard.respuestas_rapidas_json, []);
    const match = elegirRespuestaRapida(texto, faqs);
    if (match) {
      await enviarTextoWizard({
        id_configuracion,
        telefono,
        business_phone_id,
        accessToken,
        texto: conCierreDeVenta(
          match.faq.respuesta,
          semillaCierre(telefono, match.indice),
        ),
      });
      await decir(
        `wizard: respuesta rápida #${match.indice} ("${match.faq.pregunta}") → sin IA`,
      );
      return { paqueteEnviado: true, saltarIA: true, bloqueMotor };
    }
  }
  /* El prefill del anuncio ("¡Hola! Quiero comprar el Set de 9 Cuchillos")
     matchea intención de compra por el "quiero comprar" — y hasta por el
     número del NOMBRE del producto. Pero el paquete que se acaba de enviar
     ES la respuesta a ese timbre (precios + pregunta gancho): dejar correr
     la IA aquí hacía que repitiera la pregunta de cantidad un mensaje
     después (caso bautista). Solo si trae cantidad explícita sigue la IA. */
  if (pareceIntencionCompra(texto) && !esSaludoDeAnuncio(texto)) {
    await decir(`wizard: intención de compra en el primer mensaje → sigue la IA`);
    return { paqueteEnviado: true, saltarIA: false, bloqueMotor };
  }
  if (pareceIntencionCompra(texto)) {
    await decir(
      `wizard: prefill del anuncio (no intención real) → el paquete responde, sin IA`,
    );
  }
  // Una pregunta de verdad que las quemadas no cubrieron ("sirve para una
  // tele de tubo vieja") merece respuesta: IA con la ficha. Lo que NO es
  // pregunta ni compra es una variante de "quiero el producto" — con o sin
  // typos — y eso ya lo respondió el paquete.
  if (pareceRegunta(texto) && !esSaludoOGenerico(texto)) {
    await decir(`wizard: pregunta fuera de las rápidas → sigue la IA con la ficha`);
    return { paqueteEnviado: true, saltarIA: false, bloqueMotor };
  }
  await decir(
    `wizard: sin pregunta ni compra → el paquete responde, turno cerrado sin IA (0 tokens)`,
  );
  return { paqueteEnviado: true, saltarIA: true, bloqueMotor };
}

/* El último mensaje del bot pidió datos del cierre (nombre, dirección...):
   lo que el cliente conteste es un dato, no una pregunta. Una quemada ahí
   ("Quito, por el envío" → FAQ de envío) rompería la toma del pedido. */
const RE_PIDE_DATOS =
  /nombre completo|nombres? y apellidos?|direcci[oó]n|ciudad|tel[eé]fono|celular|n[uú]mero de contacto|referencia|provincia|barrio|sector|c[eé]dula|agencia m[aá]s cercana|en qu[eé] ciudad|a qu[eé] ciudad|d[oó]nde te lo enviamos|datos para el env[ií]o|confirmas? (tu|el|los) (pedido|datos)/i;

async function ultimoMensajeDelBotPideDatos(id_configuracion, id_cliente) {
  try {
    const [m] = await db.query(
      `SELECT texto_mensaje FROM mensajes_clientes
        WHERE id_configuracion = ? AND celular_recibe = ? AND rol_mensaje = 1
          AND tipo_mensaje = 'text'
        ORDER BY id DESC LIMIT 1`,
      {
        replacements: [id_configuracion, String(id_cliente)],
        type: db.QueryTypes.SELECT,
      },
    );
    return Boolean(m && RE_PIDE_DATOS.test(m.texto_mensaje || ''));
  } catch {
    return false;
  }
}

/**
 * Turnos siguientes: si la pregunta calza con una respuesta rápida del
 * producto en juego, se manda y se devuelve manejado=true (la IA no corre).
 */
async function intentarRespuestaRapida({
  id_configuracion,
  id_cliente,
  telefono,
  business_phone_id,
  accessToken,
  estado_contacto,
  texto_mensaje,
  log,
}) {
  const decir = logDe(log);
  const texto = String(texto_mensaje || '').trim();
  if (!texto || texto.length > 400) return { manejado: false };
  if (pareceIntencionCompra(texto)) return { manejado: false };

  const r = await wizardDelClienteEnJuego(id_configuracion, id_cliente);
  if (!r || Number(r.wizard.usar_respuestas_rapidas) !== 1) {
    return { manejado: false };
  }
  const faqs = leerJson(r.wizard.respuestas_rapidas_json, []);
  const match = elegirRespuestaRapida(texto, faqs);
  if (!match) return { manejado: false };

  if (!(await botHabilitado(id_configuracion, estado_contacto))) {
    return { manejado: false };
  }
  if (await ultimoMensajeDelBotPideDatos(id_configuracion, id_cliente)) {
    await decir(`wizard: el bot estaba pidiendo datos → no uso la quemada`);
    return { manejado: false };
  }

  /* Con un flujo de pasos activo, la quemada retoma la pregunta pendiente del
     embudo en vez del remate genérico: "predefinida y termina con la pregunta
     anterior", que es como el negocio lo opera a mano. */
  const preguntaFlujo = await preguntaPendienteFlujo(
    id_configuracion,
    id_cliente,
  );
  await enviarTextoWizard({
    id_configuracion,
    telefono,
    business_phone_id,
    accessToken,
    texto: preguntaFlujo
      ? `${String(match.faq.respuesta).trim()}\n\n${preguntaFlujo}`
      : conCierreDeVenta(
          match.faq.respuesta,
          semillaCierre(telefono, match.indice),
        ),
  });
  await decir(
    `⚡ wizard: respuesta rápida #${match.indice} ("${match.faq.pregunta}") producto ${r.producto.id} → sin IA`,
  );
  return { manejado: true, id_producto: r.producto.id, indice: match.indice };
}

/* ══════════════════════════════════════════════════════════════
   Flujo de venta por pasos (embudo manual por copys, 0 tokens)
   ══════════════════════════════════════════════════════════════
   El negocio define en /productos2 una secuencia de pasos: "cuando el cliente
   responda X (edad, ciudad, una opción), envía este copy tal cual". El paso 0
   espera la respuesta a la pregunta gancho del mensaje inicial. Si la
   respuesta NO valida el paso (el cliente se desvió con una pregunta), el
   turno cae a la cadena de siempre: respuesta rápida → IA con la ficha; la
   rápida y la IA terminan retomando la pregunta pendiente del paso
   (`preguntaPendienteFlujo`), que es como el negocio lo opera a mano.
   El flujo NO toma pedidos: su último paso deja al cliente entregando datos y
   ahí la IA (ficha del pedido + auto-orden) valida y cierra, que es donde un
   guion fijo se rompe con datos incompletos. */

function pasosDelFlujo(wizard) {
  if (Number(wizard?.usar_flujo_pasos) !== 1) return [];
  const pasos = leerJson(wizard?.flujo_pasos_json, []);
  if (!Array.isArray(pasos)) return [];
  return pasos.filter(
    (p) =>
      p &&
      ['edad', 'ciudad', 'opcion', 'libre'].includes(p.espera) &&
      (String(p.copy || '').trim() ||
        (p.espera === 'opcion' &&
          (p.opciones || []).some((o) => String(o?.copy || '').trim()))),
  );
}

const normFlujo = (t) =>
  String(t || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/\s+/g, ' ')
    .trim();

const escaparRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Sin ciclo: fichaPedido solo requiere este módulo DENTRO de funciones.
const { distanciaEdicion } = require('../utils/fichaPedido');

const NUMEROS_EN_PALABRAS = {
  un: 1, uno: 1, una: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5,
  seis: 6, siete: 7, ocho: 8, nueve: 9, diez: 10,
};

/* Cantidades DISTINTAS mencionadas en el texto (dígitos, aun pegados a
   letras, y números en palabras). Los PRECIOS no cuentan: "el de 39.99" es
   una sola promo, no las cantidades 39 y 99. */
function numerosEnTexto(t) {
  const sinPrecios = String(t).replace(/\d{1,4}[.,]\d{2}(?!\d)/g, ' ');
  const set = new Set();
  for (const m of sinPrecios.matchAll(/(?<!\d)(\d{1,3})(?!\d)/g)) {
    set.add(Number(m[1]));
  }
  for (const [palabra, n] of Object.entries(NUMEROS_EN_PALABRAS)) {
    if (new RegExp(`(^|[^a-zñ])${palabra}([^a-zñ]|$)`).test(sinPrecios)) {
      set.add(n);
    }
  }
  return set;
}

const EDADES_EN_PALABRAS = {
  siete: 7, ocho: 8, nueve: 9, diez: 10, once: 11, doce: 12, trece: 13,
  catorce: 14, quince: 15, dieciseis: 16, diecisiete: 17, dieciocho: 18,
  diecinueve: 19, veinte: 20, veintiuno: 21, veintidos: 22, veintitres: 23,
};

function extraerEdad(texto) {
  // (?<!\d)(?!\d) y no \b: "tiene19" pega los dígitos a la letra y \b no
  // separa letra de dígito (caso real UP NOW: "tiene19" caía a la IA).
  const m = String(texto || '').match(/(?<!\d)(\d{1,2})(?!\d)/);
  if (m) return Number(m[1]);
  const t = normFlujo(texto);
  for (const [palabra, n] of Object.entries(EDADES_EN_PALABRAS)) {
    if (new RegExp(`\\b${palabra}\\b`).test(t)) return n;
  }
  return null;
}

/* Provincias y ciudades del Ecuador (normalizadas, sin tildes). Una palabra
   del set valida el paso "ciudad" aunque venga en frase ("estoy en quito");
   los nombres compuestos van aparte y se buscan como substring. */
const LUGARES_EC = new Set([
  // provincias
  'azuay', 'bolivar', 'canar', 'carchi', 'chimborazo', 'cotopaxi',
  'esmeraldas', 'galapagos', 'guayas', 'imbabura', 'loja', 'manabi',
  'morona', 'napo', 'orellana', 'pastaza', 'pichincha', 'sucumbios',
  'tungurahua', 'zamora',
  // ciudades
  'quito', 'guayaquil', 'cuenca', 'ambato', 'machala', 'duran', 'manta',
  'portoviejo', 'ibarra', 'riobamba', 'quevedo', 'milagro', 'latacunga',
  'babahoyo', 'tulcan', 'salinas', 'otavalo', 'cayambe', 'atuntaqui',
  'sangolqui', 'daule', 'samborondon', 'montecristi', 'chone', 'jipijapa',
  'huaquillas', 'pasaje', 'azogues', 'guaranda', 'puyo', 'tena', 'macas',
  'coca', 'catamayo', 'cariamanga', 'machachi', 'playas', 'ventanas',
  'vinces', 'calceta', 'pedernales', 'carapungo', 'calderon',
]);
const LUGARES_EC_FRASES = [
  'el oro', 'los rios', 'santa elena', 'santo domingo', 'lago agrio',
  'nueva loja', 'el carmen', 'la libertad', 'santa rosa', 'la troncal',
  'el triunfo', 'san lorenzo',
];

/* Palabras que delatan que la respuesta corta NO es una ciudad sino una
   pregunta/tema ("tiene registro sanitario", "el domingo le confirmo"). */
const NO_ES_CIUDAD = new Set([
  'tiene', 'tienen', 'tengo', 'hay', 'sirve', 'sirven', 'precio', 'precios',
  'cuanto', 'cuanta', 'cuantos', 'cuantas', 'como', 'donde', 'cuando',
  'quiero', 'quisiera', 'deme', 'dame', 'envio', 'envios', 'envian',
  'entrega', 'entregan', 'gratis', 'foto', 'fotos', 'video', 'videos',
  'info', 'informacion', 'registro', 'sanitario', 'garantia', 'pago',
  'pagar', 'tarjeta', 'efectivo', 'gracias', 'hola', 'buenas', 'buenos',
  'dias', 'tardes', 'noches', 'producto', 'frasco', 'frascos', 'combo',
  'combos', 'promocion', 'edad', 'anos', 'hijo', 'hija', 'ok', 'dale',
  'listo', 'bueno', 'confirmo', 'confirma', 'manana', 'lunes', 'martes',
  'miercoles', 'jueves', 'viernes', 'sabado', 'domingo', 'semana', 'tarde',
  'noche', 'luego', 'despues', 'ahorita', 'rato',
]);

/* Función PURA (la usa la batería de regresión): decide si el texto del
   cliente responde el paso. Devuelve { valida } y, según el caso, la opción
   matcheada, el caso especial, o fuera_rango para la edad. */
function validarPasoFlujo(paso, texto) {
  const t = normFlujo(texto);
  if (!t) return { valida: false };

  // Casos especiales primero ("Ecuador" cuando se pide la ciudad → repregunta
  // fija sin avanzar). Un caso sin copy no cuenta.
  for (const caso of Array.isArray(paso.casos) ? paso.casos : []) {
    const claves = (caso?.contiene || []).map(normFlujo).filter(Boolean);
    if (
      claves.length &&
      String(caso?.copy || '').trim() &&
      claves.some((c) => t.includes(c))
    ) {
      return { valida: false, caso };
    }
  }

  switch (paso.espera) {
    case 'edad': {
      const edad = extraerEdad(texto);
      if (edad == null) return { valida: false };
      const min = Number(paso.min ?? 0);
      const max = Number(paso.max ?? 120);
      if (edad >= min && edad <= max) return { valida: true, edad };
      return { valida: false, fuera_rango: true, edad };
    }
    case 'opcion': {
      /* Pedido COMPLEJO ("dos combos de 3, es decir 6"): 2+ cantidades
         distintas Y palabras de compra. Matchear una sola clave acá elegía
         la promo equivocada (caso real UP NOW: "dos combos de x 3" salió
         como promo 2). Se marca para que el embudo se lo entregue a la IA,
         que sí sabe tomar pedidos especiales con la ficha. Una pregunta tipo
         "¿1 o 2?" NO es pedido complejo: va a rápidas/IA con retome. */
      const hablaDeCompra =
        /(combo|frasco|unidad|lleva|llevo|quiero|ayuda|dame|deme|pedido|compr)/.test(
          t,
        );
      if (hablaDeCompra && numerosEnTexto(t).size >= 2) {
        return { valida: false, ambigua: true, pedido_complejo: true };
      }
      const matches = [];
      (Array.isArray(paso.opciones) ? paso.opciones : []).forEach((op, i) => {
        const claves = (op?.claves || []).map(normFlujo).filter(Boolean);
        const pega = claves.some((c) => {
          // Una clave sin espacios matchea solo como PALABRA ENTERA: "21.99"
          // no es "1" y "algunos" no es "uno". La puntuación pegada ("2?",
          // "2,") cuenta como borde. Las claves con espacios ("un frasco")
          // van por substring.
          if (c.includes(' ')) return t.includes(c);
          if (
            new RegExp(
              `(^|[\\s.,;:!?()])${escaparRegex(c)}($|[\\s.,;:!?()])`,
            ).test(t)
          ) {
            return true;
          }
          // Typo del cliente ("a domiclo" → "domicilio"): claves de 5+ letras
          // toleran 1 error, de 8+ toleran 2. Mismos umbrales que la ciudad.
          // SOLO claves alfabéticas: "32.99"≈"39.99" con distancia 1 haría
          // ambiguas todas las promos por precio.
          if (!/^[a-zñ]+$/.test(c)) return false;
          if (c.length < 5) return false;
          const tope = c.length >= 8 ? 2 : 1;
          return t
            .split(' ')
            .some(
              (w) =>
                w.length >= 4 &&
                Math.abs(w.length - c.length) <= tope &&
                distanciaEdicion(w, c, tope) <= tope,
            );
        });
        if (pega) matches.push({ opcion: op, indice: i });
      });
      if (matches.length === 1) {
        return { valida: true, opcion: matches[0].opcion, indice: matches[0].indice };
      }
      return { valida: false, ambigua: matches.length > 1 };
    }
    case 'ciudad': {
      // La pregunta anterior pidió la ciudad, pero "corto y sin ?" NO basta:
      // "tiene registro sanitario" pasaba como ciudad (caso real UP NOW).
      // Regla en dos niveles: una provincia/ciudad EC conocida valida SIEMPRE
      // (aunque venga en frase); si no hay conocida, vale solo una respuesta
      // corta sin palabras de pregunta/tema.
      if (t.includes('?')) return { valida: false };
      const palabras = t.split(' ').filter(Boolean);
      // `lugar` = el nombre detectado, para que {{respuesta}} interpole
      // "Quito" y no la frase entera ("estoy en quito" → "Estoy En Quito").
      const frase = LUGARES_EC_FRASES.find((n) => t.includes(n));
      if (frase) return { valida: true, lugar: frase };
      const conocida = palabras.find((w) => LUGARES_EC.has(w));
      if (conocida) return { valida: true, lugar: conocida };
      if (palabras.length > 4) return { valida: false };
      if (palabras.some((w) => NO_ES_CIUDAD.has(w))) return { valida: false };
      const letras = t.replace(/[^a-z]/g, '');
      if (letras.length >= 3 && !/\d/.test(t)) return { valida: true };
      return { valida: false };
    }
    case 'libre':
      return { valida: true };
    default:
      return { valida: false };
  }
}

/* El "mensaje de VENTA REALIZADA" (Flujo 7 del embudo): copy + imagen que
   salen cuando la IA cierra la venta. Vive DENTRO de flujo_pasos_json como
   entrada espera:'venta_realizada'; pasosDelFlujo lo excluye de la secuencia
   (solo filtra las 4 esperas), así que no afecta los índices de los pasos. */
function mensajeVentaRealizada(wizard) {
  if (Number(wizard?.usar_flujo_pasos) !== 1) return null;
  const pasos = leerJson(wizard?.flujo_pasos_json, []);
  const fin = (Array.isArray(pasos) ? pasos : []).find(
    (p) => p && p.espera === 'venta_realizada',
  );
  if (!fin) return null;
  const copy = String(fin.copy || '').trim();
  const media = (Array.isArray(fin.media) ? fin.media : []).filter((u) =>
    /^https?:\/\//i.test(String(u || '')),
  );
  if (!copy && !media.length) return null;
  return {
    copy,
    media,
    // true = al cerrar NO se le envía el resumen técnico al cliente, solo
    // este mensaje. La orden y la columna se procesan igual (paso 10).
    ocultar_resumen: Number(fin.ocultar_resumen) === 1,
  };
}

async function progresoFlujo(id_cliente, id_producto) {
  const [p] = await db.query(
    `SELECT id, paso, estado, estado_contacto_inicio, updated_at
       FROM productos_wizard_flujo
      WHERE id_cliente = ? AND id_producto = ? LIMIT 1`,
    { replacements: [id_cliente, id_producto], type: db.QueryTypes.SELECT },
  );
  return p || null;
}

/* Se llama al enviar el paquete inicial: deja el flujo en el paso 0. Si el
   paquete se reenvía (ventana de 48h vencida), el flujo arranca de nuevo. */
async function iniciarFlujoPasos({
  id_configuracion,
  id_cliente,
  id_producto,
  estado_contacto,
}) {
  // created_at/updated_at explícitos: la tabla la crea db.sync y Sequelize NO
  // le pone default SQL a los DATE (el NOW es de ORM, y este INSERT es raw).
  await db.query(
    `INSERT INTO productos_wizard_flujo
       (id_configuracion, id_cliente, id_producto, paso, estado, estado_contacto_inicio, created_at, updated_at)
     VALUES (?, ?, ?, 0, 'activo', ?, NOW(), NOW())
     ON DUPLICATE KEY UPDATE paso = 0, estado = 'activo',
       estado_contacto_inicio = VALUES(estado_contacto_inicio),
       updated_at = NOW()`,
    {
      replacements: [
        id_configuracion,
        id_cliente,
        id_producto,
        estado_contacto || null,
      ],
      type: db.QueryTypes.INSERT,
    },
  );
}

async function terminarFlujo(id_progreso) {
  await db.query(
    `UPDATE productos_wizard_flujo SET estado = 'terminado', updated_at = NOW()
      WHERE id = ?`,
    { replacements: [id_progreso], type: db.QueryTypes.UPDATE },
  );
}

/* Media fija de un paso: mismas garantías que el paquete inicial (dedupe por
   dedupeMedia, texto después de la media). */
async function enviarMediaFlujo({
  id_configuracion,
  id_cliente,
  telefono,
  business_phone_id,
  accessToken,
  urls,
  log,
}) {
  const decir = logDe(log);
  const lista = (Array.isArray(urls) ? urls : [])
    .map((u) => String(u || '').trim())
    .filter((u) => /^https?:\/\//i.test(u))
    .slice(0, 4);
  if (!lista.length) return 0;

  ofrecerMedia(id_cliente, lista);
  const nuevas = await filtrarMediaNueva({
    id_cliente,
    id_configuracion,
    urls: lista,
    etiqueta: 'media flujo',
    log: decir,
  });

  let enviados = 0;
  for (const url of nuevas) {
    const tipo = /\.(mp4|mov|3gp)(\?|$)/i.test(url) ? 'video' : 'image';
    const r = await enviarMedioWhatsapp({
      tipo,
      url_archivo: url,
      phone_whatsapp_to: telefono,
      business_phone_id,
      accessToken,
      id_configuracion,
      responsable: RESPONSABLE_FLUJO,
    });
    if (r?.ok) enviados += 1;
    else {
      olvidarEnviado(id_cliente, url);
      await decir(`⚠️ flujo: falló ${tipo} ${url}`);
    }
  }
  // El copy debe llegarle DESPUÉS de la media (misma razón que el paquete).
  if (enviados > 0) await new Promise((r) => setTimeout(r, 2000));
  return enviados;
}

/* ── Derivación al producto ALTERNO por edad fuera de rango ──
   El negocio configura en el paso `edad` un segundo producto (p. ej. el
   suplemento "para adultos"): en vez de despedirse, el bot presenta el
   alterno (copy_invalido), envía SU paquete (fotos + texto), y desde ahí las
   respuestas rápidas, la ficha y la IA responden por ESE producto — el
   cambio de "producto en juego" es el mismo mecanismo del resolver por
   texto (sembrarProductoEnJuego). Si el flujo del alterno también arranca
   preguntando la edad y la edad conocida SÍ entra en su rango, se hereda:
   el paquete sale sin el gancho y el paso 0 se responde solo — al cliente
   no se le pregunta la edad dos veces. */
async function derivarProductoAlterno({
  id_configuracion,
  id_cliente,
  telefono,
  business_phone_id,
  accessToken,
  estado_contacto,
  alternoId,
  edad,
  copyPresentacion,
  texto_mensaje,
  progresoActualId,
  log,
}) {
  const decir = logDe(log);
  const wizard2 = await wizardActivoDeProducto(alternoId);
  if (!wizard2) return { manejado: false };
  const [prod2] = await db.query(
    `SELECT * FROM productos_chat_center
      WHERE id = ? AND id_configuracion = ? AND eliminado = 0 LIMIT 1`,
    { replacements: [alternoId, id_configuracion], type: db.QueryTypes.SELECT },
  );
  if (!prod2) return { manejado: false };
  await enriquecerProductoWizard(prod2);

  // 1. Presentación (el copy_invalido del paso: ahí el negocio explica que
  //    este producto no aplica y presenta el otro).
  if (copyPresentacion) {
    await enviarTextoWizard({
      id_configuracion,
      telefono,
      business_phone_id,
      accessToken,
      texto: copyPresentacion,
      responsable: RESPONSABLE_FLUJO,
    });
  }

  // 2. El alterno pasa a ser el producto EN JUEGO: rápidas, ficha e IA.
  await sembrarProductoEnJuego({
    id_cliente,
    id_configuracion,
    producto: prod2,
    texto_mensaje,
  });

  // 3. ¿El flujo del alterno arranca pidiendo edad y la conocida le sirve?
  const pasos2 = pasosDelFlujo(wizard2);
  let v2 = null;
  const heredaEdad =
    pasos2.length > 0 &&
    pasos2[0].espera === 'edad' &&
    Number.isFinite(Number(edad)) &&
    (v2 = validarPasoFlujo(pasos2[0], String(edad))).valida === true;

  // 4. Paquete del alterno (sin gancho si la edad se hereda).
  await enviarPaqueteInicial({
    id_configuracion,
    id_cliente,
    telefono,
    business_phone_id,
    accessToken,
    producto: prod2,
    wizard: wizard2,
    log: decir,
    omitirGancho: heredaEdad,
  });

  // 5. Progresos: el flujo original termina; el del alterno arranca (y si la
  //    edad se hereda, su paso 0 se responde solo).
  await terminarFlujo(progresoActualId);
  if (pasos2.length) {
    await iniciarFlujoPasos({
      id_configuracion,
      id_cliente,
      id_producto: alternoId,
      estado_contacto,
    });
    if (heredaEdad) {
      const copy0 = String((v2.opcion && v2.opcion.copy) || pasos2[0].copy || '')
        .replace(/\{\{\s*respuesta\s*\}\}/gi, String(edad))
        .trim();
      if (copy0) {
        await enviarTextoWizard({
          id_configuracion,
          telefono,
          business_phone_id,
          accessToken,
          texto: copy0,
          responsable: RESPONSABLE_FLUJO,
        });
      }
      await db.query(
        `UPDATE productos_wizard_flujo SET paso = 1, estado = ?, updated_at = NOW()
          WHERE id_cliente = ? AND id_producto = ?`,
        {
          replacements: [
            pasos2.length > 1 ? 'activo' : 'terminado',
            id_cliente,
            alternoId,
          ],
          type: db.QueryTypes.UPDATE,
        },
      );
    }
  }

  await decir(
    `🔀 flujo: edad ${edad} fuera de rango → derivado al producto alterno ` +
      `${alternoId} "${prod2.nombre}"${heredaEdad ? ' (edad heredada: paso 0 auto)' : ''}`,
  );
  return { manejado: true, derivado: alternoId };
}

/* La pregunta del paso pendiente, para que las respuestas rápidas y la IA
   retomen el embudo tras un desvío. Null si no hay flujo activo. */
async function preguntaPendienteFlujo(id_configuracion, id_cliente) {
  try {
    const r = await wizardDelClienteEnJuego(id_configuracion, id_cliente);
    if (!r) return null;
    const pasos = pasosDelFlujo(r.wizard);
    if (!pasos.length) return null;
    const prog = await progresoFlujo(id_cliente, r.producto.id);
    if (!prog || prog.estado !== 'activo' || prog.paso >= pasos.length) {
      return null;
    }
    return String(pasos[prog.paso].pregunta || '').trim() || null;
  } catch {
    return null;
  }
}

/* El turno del flujo: va en el webhook DESPUÉS del mensaje fijo y ANTES de
   las respuestas rápidas. Si la respuesta valida el paso, sale el copy
   siguiente (0 tokens) y avanza; si no, devuelve manejado:false y el turno
   sigue su cadena normal. */
async function intentarPasoFlujo({
  id_configuracion,
  id_cliente,
  telefono,
  business_phone_id,
  accessToken,
  estado_contacto,
  texto_mensaje,
  log,
}) {
  const decir = logDe(log);
  const texto = String(texto_mensaje || '').trim();
  if (!texto || texto.length > 400) return { manejado: false };

  const r = await wizardDelClienteEnJuego(id_configuracion, id_cliente);
  if (!r) return { manejado: false };
  const pasos = pasosDelFlujo(r.wizard);
  if (!pasos.length) return { manejado: false };

  const prog = await progresoFlujo(id_cliente, r.producto.id);
  if (!prog || prog.estado === 'terminado' || prog.paso >= pasos.length) {
    return { manejado: false };
  }
  /* 'respondiendo' = otro turno está en su retraso configurado: este mensaje
     cae a rápida/IA y el copy pendiente llegará solo. Si la espera quedó
     huérfana (un reinicio la mató), a los 5 minutos se deja pasar y el claim
     de abajo la rescata. */
  if (prog.estado === 'respondiendo') {
    const desde = new Date(prog.updated_at).getTime();
    const huerfana =
      Number.isFinite(desde) && Date.now() - desde > 5 * 60 * 1000;
    if (!huerfana) return { manejado: false };
  }

  // El contacto cambió de columna (la IA cerró, lo tomó un humano, Dropi lo
  // movió): el embudo ya no es el dueño de la conversación.
  if (
    prog.estado_contacto_inicio &&
    estado_contacto &&
    prog.estado_contacto_inicio.toLowerCase() !==
      String(estado_contacto).toLowerCase()
  ) {
    await terminarFlujo(prog.id);
    await decir(`🪜 flujo: el contacto salió de "${prog.estado_contacto_inicio}" → flujo terminado`);
    return { manejado: false };
  }

  if (!(await botHabilitado(id_configuracion, estado_contacto))) {
    return { manejado: false };
  }

  const paso = pasos[prog.paso];

  /* La FAQ le gana a los pasos de validación DÉBIL (ciudad/libre): "tiene
     registro sanitario" no es una ciudad aunque venga sin "?". Devolver
     manejado:false deja que la respuesta rápida conteste y retome la
     pregunta del paso, que es el comportamiento del embudo a mano. */
  if (
    ['ciudad', 'libre'].includes(paso.espera) &&
    Number(r.wizard.usar_respuestas_rapidas) === 1
  ) {
    const faqs = leerJson(r.wizard.respuestas_rapidas_json, []);
    if (elegirRespuestaRapida(texto, faqs)) return { manejado: false };
  }

  const v = validarPasoFlujo(paso, texto);

  // {{respuesta}} en un copy = lo que el cliente contestó, en Título ("quito"
  // → "Quito"). Si el validador detectó un lugar dentro de una frase, se
  // interpola SOLO el lugar; y en pasos de ciudad el typo se corrige a la
  // ciudad real ("Guayuquil" → "Guayaquil"), igual que hace la ficha.
  let respuestaBase = String(v.lugar || texto);
  if (paso.espera === 'ciudad') {
    try {
      const { corregirCiudadTypo } = require('../utils/fichaPedido');
      respuestaBase = corregirCiudadTypo(respuestaBase);
    } catch {
      /* sin corrección: se interpola como vino */
    }
  }
  const respuestaTitulo = respuestaBase
    .toLowerCase()
    .replace(/\p{L}+/gu, (w) => w.charAt(0).toUpperCase() + w.slice(1));
  const conRespuesta = (c) =>
    String(c || '').replace(/\{\{\s*respuesta\s*\}\}/gi, respuestaTitulo);

  const enviarCopy = async (copy, media) => {
    /* Retraso configurable del paso: el negocio decide si el embudo responde
       al instante o se toma su tiempo (hasta 3 min). Tope 180s (sanitizador).
       El candado de abajo (estado 'respondiendo') cubre la ventana. */
    const retraso = Math.min(Math.max(Number(paso.retraso) || 0, 0), 180);
    if (retraso > 0) {
      await new Promise((r) => setTimeout(r, retraso * 1000));
    }
    await enviarMediaFlujo({
      id_configuracion,
      id_cliente,
      telefono,
      business_phone_id,
      accessToken,
      urls: media,
      log: decir,
    });
    if (copy) {
      await enviarTextoWizard({
        id_configuracion,
        telefono,
        business_phone_id,
        accessToken,
        texto: copy,
        responsable: RESPONSABLE_FLUJO,
      });
    }
  };

  // Caso especial ("Ecuador" → "¿de qué ciudad?"): copy fijo, sin avanzar.
  if (v.caso) {
    await enviarCopy(conRespuesta(v.caso.copy).trim(), v.caso.media);
    await decir(`🪜 flujo: caso especial en paso ${prog.paso} → copy sin avanzar`);
    return { manejado: true };
  }

  // Edad fuera de rango: si el paso tiene producto ALTERNO configurado, se
  // deriva ahí (presentación + paquete del alterno + su flujo). Si no, sale
  // el copy_invalido y el flujo TERMINA. Sin nada de eso, cae a rápidas/IA.
  if (v.fuera_rango) {
    const alternoId = Number(paso.id_producto_alterno) || 0;
    if (alternoId && alternoId !== r.producto.id) {
      const derivado = await derivarProductoAlterno({
        id_configuracion,
        id_cliente,
        telefono,
        business_phone_id,
        accessToken,
        estado_contacto,
        alternoId,
        edad: v.edad,
        copyPresentacion: conRespuesta(paso.copy_invalido).trim(),
        texto_mensaje: texto,
        progresoActualId: prog.id,
        log: decir,
      });
      if (derivado?.manejado) return derivado;
    }
    const copy = conRespuesta(paso.copy_invalido).trim();
    if (!copy) return { manejado: false };
    await enviarCopy(copy, null);
    await terminarFlujo(prog.id);
    await decir(`🪜 flujo: edad ${v.edad} fuera de rango → copy_invalido, flujo terminado`);
    return { manejado: true };
  }

  /* Pedido complejo en un paso de opción ("dos combos de 3"): el embudo se
     hace a un lado DEL TODO (flujo terminado, sin pregunta de retome) y la IA
     toma el pedido especial con la ficha — que es como lo opera el negocio a
     mano ("igual se le toma la orden"). Sin esto, el paso matcheaba una sola
     clave y elegía la promo equivocada, o la IA y el embudo se mezclaban. */
  if (v.pedido_complejo) {
    await terminarFlujo(prog.id);
    await decir(
      `🪜 flujo: pedido complejo en paso ${prog.paso} ("${texto.slice(0, 60)}") → flujo terminado, la IA toma el pedido`,
    );
    return { manejado: false };
  }

  if (!v.valida) return { manejado: false };

  const copy = conRespuesta((v.opcion && v.opcion.copy) || paso.copy).trim();
  const media =
    v.opcion && Array.isArray(v.opcion.media) && v.opcion.media.length
      ? v.opcion.media
      : paso.media;
  if (!copy && !(Array.isArray(media) && media.length)) {
    return { manejado: false };
  }

  /* Candado del paso: con retrasos largos (hasta 3 min) el cliente puede
     escribir otra vez ANTES de que salga el copy; sin esto, ese turno leería
     el mismo paso y lo respondería duplicado. El claim es atómico (gana el
     UPDATE que encuentre 'activo'); mientras dura la espera el progreso queda
     'respondiendo' y los otros turnos caen a rápida/IA. Si un reinicio mata
     la espera, la fila se rescata sola a los 5 minutos. */
  const [, metaClaim] = await db.query(
    `UPDATE productos_wizard_flujo
        SET estado = 'respondiendo', updated_at = NOW()
      WHERE id = ? AND (estado = 'activo'
         OR (estado = 'respondiendo' AND updated_at < NOW() - INTERVAL 5 MINUTE))`,
    { replacements: [prog.id] },
  );
  const claimOk =
    typeof metaClaim === 'number'
      ? metaClaim > 0
      : Number(metaClaim?.affectedRows || 0) > 0;
  if (!claimOk) {
    await decir(`🪜 flujo: paso ${prog.paso} ya lo está respondiendo otro turno`);
    return { manejado: false };
  }

  try {
    await enviarCopy(copy, media);
  } catch (eEnvio) {
    // Se devuelve el paso a 'activo' para no dejar el embudo colgado.
    await db.query(
      `UPDATE productos_wizard_flujo SET estado = 'activo', updated_at = NOW()
        WHERE id = ?`,
      { replacements: [prog.id], type: db.QueryTypes.UPDATE },
    );
    throw eEnvio;
  }

  const siguiente = prog.paso + 1;
  const completo = siguiente >= pasos.length;
  await db.query(
    `UPDATE productos_wizard_flujo SET paso = ?, estado = ?, updated_at = NOW()
      WHERE id = ?`,
    {
      replacements: [siguiente, completo ? 'terminado' : 'activo', prog.id],
      type: db.QueryTypes.UPDATE,
    },
  );
  await decir(
    `🪜 flujo: paso ${prog.paso} (${paso.espera}) validado → copy enviado` +
      (completo ? ' — flujo COMPLETO, lo que siga es de la IA' : ''),
  );
  return { manejado: true, paso: prog.paso, completo };
}

module.exports = {
  RESPONSABLE,
  RESPONSABLE_FIJO,
  RESPONSABLE_RAPIDA,
  RESPONSABLE_FLUJO,
  RESPONSABLES_SIN_IA,
  wizardActivoDeProducto,
  olvidarWizard,
  resolverWizardDelAnuncio,
  wizardDelClienteEnJuego,
  bloqueWizardParaMotor,
  wizardParaMotor,
  enviarPaqueteInicial,
  intentarMensajeFijoWizard,
  intentarRespuestaRapida,
  yaSeEnvioMensajeInicial,
  // Flujo de venta por pasos. Los dos primeros los usa el webhook / kanban_ia;
  // los puros (validarPasoFlujo, extraerEdad, pasosDelFlujo) son garantías de
  // la batería de regresión.
  intentarPasoFlujo,
  preguntaPendienteFlujo,
  validarPasoFlujo,
  extraerEdad,
  // Para la batería: identificar el producto por texto sin falsos positivos
  // es la puerta de entrada del mensaje fijo sin anuncio.
  elegirProductoPorTexto,
  pasosDelFlujo,
  mensajeVentaRealizada,
  // Lista de lugares EC compartida: fichaPedido corrige typos de ciudad
  // contra ella ("Guayuquil" → Guayaquil) para que el auto-orden reciba una
  // ciudad real. Una sola fuente; duplicarla ya sabemos cómo termina.
  LUGARES_EC,
  LUGARES_EC_FRASES,
};
