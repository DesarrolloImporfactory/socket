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
const RESPONSABLES_SIN_IA = ['IA_wizard', RESPONSABLE_FIJO, RESPONSABLE_RAPIDA];
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
    // bateria": podría ser cualquier cargador del catálogo).
    const calza =
      sig.length === 1 ? aciertos === 1 && sig[0].length >= 4 : cobertura >= 0.6;
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
}) {
  const decir = logDe(log);
  const { imagenes, videos } = paqueteMedia({ producto, wizard });
  const texto =
    String(wizard.mensaje_inicial || '').trim() ||
    componerMensajeInicial({ producto, wizard });

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
    `⚡ wizard: respuesta rápida #${match.indice} ("${match.faq.pregunta}") producto ${r.producto.id} → sin IA`,
  );
  return { manejado: true, id_producto: r.producto.id, indice: match.indice };
}

module.exports = {
  RESPONSABLE,
  RESPONSABLE_FIJO,
  RESPONSABLE_RAPIDA,
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
};
