'use strict';

/**
 * Auto-creación de órdenes Dropi cuando el bot confirma la venta
 * (trigger [generar_guia]:true → columna generar_guia en Kanban IA).
 *
 * Best-effort: si CUALQUIER paso falla, loguea en dropi_auto_ordenes_log
 * y el flujo manual sigue como siempre.
 * Gate: configuraciones.auto_crear_orden_dropi = 1 (force=true lo salta).
 *
 * EXTRACCIÓN DE DATOS (híbrida):
 *  1. Regex sobre el mensaje final del bot (gratis/exacto, requiere
 *     prompt con resumen estructurado).
 *  2. Si faltan campos clave → extractor IA (gpt-4o-mini) sobre los
 *     últimos mensajes de la conversación, con la api_key del cliente.
 *
 * ENDPOINTS DROPI: usa exclusivamente los endpoints ya probados por el
 * flujo manual del front: /products/index, /department, /trajectory/bycity,
 * /orders/cotizaEnvioTransportadoraV2 y /orders/myorders (create).
 * El remitente sale del producto crudo (warehouse_product[].warehouse.city.cod_dane).
 *
 * IDENTIFICACIÓN DE PRODUCTO (cascada):
 *  a) Nombre que el bot escribió en el resumen (venta real)
 *  b) headline del último anuncio CTWA (cliente_productos_ad)
 *  c) ultimo_producto_ad del cliente
 *  Matcher de 3 capas: exacto → contains → tokens significativos
 *  (ignora COMBO/KIT/números; en empate prefiere fallar a manual).
 *
 * CANTIDADES/COMBOS:
 *  - qty 1 → producto base (external_id), quantity 1
 *  - qty N + combo con id_dropi en combos_producto → producto COMBO, quantity 1
 *  - qty N sin combo configurado → producto base, quantity N, unitario = total/N
 *  - Cinturón de margen: si el total del bot < costo proveedor del despacho,
 *    NO se crea la orden (cae a manual).
 *
 * RESILIENCIA (fixes):
 *  - Rate limit 429 de Dropi → conReintento429 espera y reintenta
 *    (solo en este flujo background, nunca en el service compartido).
 *  - Productos privatizados para el cliente (privated_product:true) →
 *    buscarEnIndexAmbos prueba catálogo público y privado.
 */

const axios = require('axios');
const { db } = require('../database/config');
const { decryptToken } = require('../utils/cryptoToken');
const dropiService = require('./dropi.service');
const DropiIntegrations = require('../models/dropi_integrations.model');
const {
  createOrderForClient,
  updateOrderForClient,
} = require('./dropiOrders.service');
const {
  enlazarOrdenContactoOrigen,
} = require('./contactoOrigenEnlace.service');
const {
  enviarConfirmacionOrdenBot,
} = require('./seguimiento_plantillas.service');
const { resolveRegion } = require('../utils/phoneFactor');

/* ────────────────────────── helpers ────────────────────────── */

// Nombre del país (para el prompt del extractor). NO se asume Ecuador: sale del
// país de la plantilla global aplicada, o del país de la integración Dropi.
const PAIS_NOMBRE_POR_ISO = {
  EC: 'Ecuador',
  CO: 'Colombia',
  MX: 'México',
  PE: 'Perú',
  CL: 'Chile',
  GT: 'Guatemala',
  PA: 'Panamá',
  AR: 'Argentina',
};
function nombrePais(countryCode) {
  const iso = resolveRegion(countryCode); // acepta ISO ("EC") o calling ("593")
  return PAIS_NOMBRE_POR_ISO[iso] || 'Ecuador';
}

// ¿El cliente pidió envío a agencia/oficina Servientrega? Se lee de la línea
// "Envío:" del resumen del bot (datosBot.modalidad_envio). Si aplica, el
// auto-orden fuerza Servientrega en vez de la transportadora más barata.
function esEnvioAgenciaServientrega(datosBot) {
  const t = String(datosBot?.modalidad_envio || '').toLowerCase();
  if (!t) return false;
  return /servientrega|servi\s?entrega/.test(t) || /agenc|oficin|retiro/.test(t);
}

function nombreTransportadora(q) {
  return String(
    q?.distributionCompany?.name ??
      q?.transportadora ??
      q?.distribution_company?.name ??
      q?.name ??
      '',
  )
    .trim()
    .toUpperCase();
}

function normalizarTexto(s) {
  return String(s || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase();
}

function parsearPrecio(s) {
  const m = String(s || '')
    .replace(',', '.')
    .match(/(\d+(?:\.\d{1,2})?)/);
  return m ? Number(m[1]) : 0;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Reintenta una llamada a Dropi SOLO cuando responde 429 (rate limit).
 * 429 = la petición NO se ejecutó → reintentar es seguro (no duplica).
 */
async function conReintento429(fn, { intentos = 3, esperaMs = 120000 } = {}) {
  let ultimoErr;
  for (let i = 1; i <= intentos; i++) {
    try {
      return await fn();
    } catch (e) {
      ultimoErr = e;
      const status = e?.statusCode || e?.response?.status;
      const is429 =
        status === 429 ||
        /exceeded the allowed number of requests/i.test(e?.message || '');
      if (is429 && i < intentos) {
        console.log(
          `[AutoOrden] Dropi 429 (rate limit). Reintento ${i}/${intentos - 1} en ${Math.round(
            esperaMs / 1000,
          )}s`,
        );
        await sleep(esperaMs);
        continue;
      }
      throw e;
    }
  }
  throw ultimoErr;
}

const STOPWORDS_MATCH = new Set([
  'COMBO',
  'KIT',
  'PACK',
  'PROMO',
  'PROMOCION',
  'OFERTA',
  'SET',
  'X',
  'DE',
  'DEL',
  'EL',
  'LA',
  'LOS',
  'LAS',
  'UN',
  'UNA',
  'PARA',
  'CON',
  'Y',
  'O',
  'POR',
  'UNIDAD',
  'UNIDADES',
  'PAR',
  'PARES',
  'PZA',
  'PZAS',
]);

function tokensSignificativos(s) {
  return normalizarTexto(s)
    .split(' ')
    .filter((t) => t && !STOPWORDS_MATCH.has(t) && !/^\d+$/.test(t));
}

function matchEnLista(lista, objetivo, pickName) {
  const target = normalizarTexto(objetivo);
  if (!target) return null;

  // 1) Match exacto
  let found = lista.find((x) => normalizarTexto(pickName(x)) === target);
  if (found) return found;

  // 2) Contains bidireccional
  found = lista.find((x) => {
    const n = normalizarTexto(pickName(x));
    return n.includes(target) || target.includes(n);
  });
  if (found) return found;

  // 3) Solapamiento de tokens significativos
  //    (ignora COMBO/KIT/numeros: "Aceite Batana Combo 1" -> [ACEITE, BATANA])
  const tTokens = tokensSignificativos(objetivo);
  if (!tTokens.length) return null;

  let best = null;
  let bestScore = 0;
  let bestInter = 0;
  let empate = false;

  for (const x of lista) {
    const nTokens = tokensSignificativos(pickName(x));
    if (!nTokens.length) continue;
    const setN = new Set(nTokens);
    const inter = tTokens.filter((t) => setN.has(t)).length;
    if (!inter) continue;
    // prioriza mas tokens coincidentes; desempata por cobertura del nombre
    const score = inter * 2 + inter / nTokens.length;
    if (score > bestScore) {
      best = x;
      bestScore = score;
      bestInter = inter;
      empate = false;
    } else if (score === bestScore) {
      empate = true; // dos productos igual de parecidos -> mejor no adivinar
    }
  }

  const minInter = Math.min(2, tTokens.length);
  if (best && !empate && bestInter >= minInter) return best;
  return null;
}

async function logAuto({
  id_configuracion,
  id_cliente,
  telefono,
  resultado,
  paso_fallo = null,
  dropi_order_id = null,
  detalle = null,
  datos_bot = null,
}) {
  try {
    await db.query(
      `INSERT INTO dropi_auto_ordenes_log
         (id_configuracion, id_cliente, telefono, resultado, paso_fallo, dropi_order_id, detalle, datos_bot)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      {
        replacements: [
          id_configuracion,
          id_cliente || null,
          telefono || null,
          resultado,
          paso_fallo,
          dropi_order_id,
          detalle ? String(detalle).slice(0, 2000) : null,
          datos_bot ? JSON.stringify(datos_bot).slice(0, 4000) : null,
        ],
        type: db.QueryTypes.INSERT,
      },
    );
  } catch (_) {}
}

/**
 * Dropi devuelve warehouse a veces como OBJETO (/products/index) y a veces
 * como ARRAY (/products/v2/:id — ver getWarehouseName en el front).
 * Este normalizador cubre ambas formas.
 */
function normWarehouse(w) {
  return Array.isArray(w) ? w[0] || null : w || null;
}

/**
 * Réplica de buildDepartment del socket handler (GET_DROPI_COTIZA_ENVIO_V2):
 * Dropi espera ciudad_destino/ciudad_remitente como objetos de ciudad
 * COMPLETOS con su department embebido.
 */
function buildDepartment(dept) {
  return {
    id: dept.id || dept.department_id,
    country_id: dept.country_id || 1,
    name: dept.name || dept.department || dept.nombre,
    created_at: dept.created_at || null,
    updated_at: dept.updated_at || null,
    deleted_at: dept.deleted_at || null,
    department_code: dept.department_code || null,
  };
}

/**
 * Objeto ciudad de la bodega remitente, directo del producto crudo
 * de /products/index (SIMPLE → warehouse_product[0].warehouse.city;
 * fallback VARIABLE → variations[].warehouse_product_variation[].warehouse.city).
 */
function pickWarehouseCityFromProduct(rawProduct) {
  const w = normWarehouse(rawProduct?.warehouse_product?.[0]?.warehouse);
  if (w?.city) return w.city;
  if (Array.isArray(rawProduct?.variations)) {
    for (const v of rawProduct.variations) {
      for (const wpv of v?.warehouse_product_variation || []) {
        const wv = normWarehouse(wpv?.warehouse);
        if (wv?.city) return wv.city;
      }
    }
  }
  return null;
}

/**
 * warehouse_id del producto crudo (SIMPLE → warehouse_product[0];
 * fallback VARIABLE), como lo resuelve el socket handler.
 */
function pickWarehouseIdFromProduct(rawProduct) {
  const wp = rawProduct?.warehouse_product?.[0];
  const w = normWarehouse(wp?.warehouse);
  return (
    Number(
      wp?.warehouse_id ||
        w?.id ||
        rawProduct?.variations?.[0]?.warehouse_product_variation?.[0]
          ?.warehouse_id ||
        0,
    ) || null
  );
}

/* ─────────────── extractor IA de respaldo ─────────────── */

/**
 * Si el regex no extrajo los datos del pedido (prompt del cliente sin
 * formato estructurado), lee los últimos mensajes de la conversación
 * desde mensajes_clientes y extrae el pedido como JSON con gpt-4o-mini.
 * Usa la api_key_openai del propio cliente.
 * Los valores que el regex SÍ encontró tienen prioridad; la IA solo
 * rellena los vacíos.
 */
async function completarDatosConIA({
  id_configuracion,
  id_cliente,
  datosBot,
  api_key_openai,
  paisNombre = 'Ecuador',
}) {
  try {
    const msgs = await db.query(
      `SELECT rol_mensaje, texto_mensaje
       FROM mensajes_clientes
       WHERE celular_recibe = ? AND id_configuracion = ?
       ORDER BY id DESC LIMIT 25`,
      {
        replacements: [id_cliente, id_configuracion],
        type: db.QueryTypes.SELECT,
      },
    );
    if (!msgs.length) return datosBot;

    const transcript = msgs
      .reverse()
      .map(
        (m) =>
          `${String(m.rol_mensaje) === '0' ? 'CLIENTE' : 'VENDEDOR'}: ${String(
            m.texto_mensaje || '',
          ).slice(0, 400)}`,
      )
      .join('\n')
      .slice(-8000);

    const { data } = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model: 'gpt-4o-mini',
        temperature: 0,
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content:
              `Extrae los datos del pedido confirmado de esta conversación de ventas COD en ${paisNombre}. ` +
              'Responde SOLO un JSON con claves: nombre, telefono, provincia, ciudad, direccion, producto, precio_total, cantidad, modalidad_envio, variedad. ' +
              'variedad = la opción del producto (color, talla, sabor o modelo) que el CLIENTE escribió en SUS mensajes. Solo cuenta si la escribió el CLIENTE; lo que diga el VENDEDOR no vale. Si el cliente nunca la nombró, null. ' +
              'producto = nombre del producto tal como lo menciona el VENDEDOR. ' +
              'precio_total = número, el total que el cliente acordó pagar. ' +
              'cantidad = número de unidades (1 si no se especifica). ' +
              `provincia = provincia de ${paisNombre} a la que pertenece la ciudad. ` +
              'modalidad_envio = "agencia servientrega" si el cliente pidió retirar en una agencia/oficina Servientrega; si es envío normal a domicilio, "domicilio". ' +
              'Si un dato no aparece en la conversación, usa null. NO inventes.',
          },
          { role: 'user', content: transcript },
        ],
      },
      {
        headers: { Authorization: `Bearer ${api_key_openai}` },
        timeout: 20000,
      },
    );

    const ia = JSON.parse(data?.choices?.[0]?.message?.content || '{}');

    // Merge: regex gana, IA rellena vacíos
    return {
      nombre: datosBot.nombre || ia.nombre || '',
      telefono: datosBot.telefono || ia.telefono || '',
      provincia: datosBot.provincia || ia.provincia || '',
      ciudad: datosBot.ciudad || ia.ciudad || '',
      direccion: datosBot.direccion || ia.direccion || '',
      producto: datosBot.producto || ia.producto || '',
      precio: datosBot.precio || String(ia.precio_total ?? '') || '',
      cantidad: datosBot.cantidad || String(ia.cantidad ?? '') || '1',
      modalidad_envio:
        datosBot.modalidad_envio || ia.modalidad_envio || '',
      variedad: datosBot.variedad || ia.variedad || '',
      _fuente_ia: true,
    };
  } catch (err) {
    console.log('[AutoOrden] extractor IA falló:', err?.message);
    return datosBot; // sigue con lo que haya; los fails normales lo registran
  }
}

/* ────────────────────── flujo principal ────────────────────── */

async function autoCrearOrdenDropi({
  id_configuracion,
  id_cliente,
  datosBot,
  api_key_openai = null,
  force = false,
}) {
  // datosBot: { nombre, telefono, provincia, ciudad, direccion, producto, precio, cantidad }
  const ctx = {
    id_configuracion,
    id_cliente,
    telefono: datosBot?.telefono,
    datos_bot: datosBot,
  };
  const fail = (paso, detalle) =>
    logAuto({ ...ctx, resultado: 'fallida', paso_fallo: paso, detalle });

  try {
    // 0. Gate por config (force=true lo salta: creación/retry manual desde el panel)
    if (!force) {
      const [cfg] = await db.query(
        `SELECT auto_crear_orden_dropi FROM configuraciones WHERE id = ? LIMIT 1`,
        { replacements: [id_configuracion], type: db.QueryTypes.SELECT },
      );
      if (!cfg || Number(cfg.auto_crear_orden_dropi) !== 1) return null;
    }

    const integration = await DropiIntegrations.findOne({
      where: { id_configuracion, deleted_at: null, is_active: 1 },
      order: [['id', 'DESC']],
    });
    if (!integration) return fail('producto', 'Sin integración Dropi activa');

    const integrationKey = decryptToken(integration.integration_key_enc);
    const country_code = integration.country_code;

    // País para el prompt del extractor: el de la plantilla global aplicada
    // (si el cliente aplicó una) o, en su defecto, el de la integración Dropi.
    // Así NO se asume Ecuador cuando el cliente trabaja en otro país.
    const [cfgPais] = await db.query(
      `SELECT pais_plantilla FROM configuraciones WHERE id = ? LIMIT 1`,
      { replacements: [id_configuracion], type: db.QueryTypes.SELECT },
    );
    const paisNombre = nombrePais(cfgPais?.pais_plantilla || country_code);

    // 0.5 Si el regex no extrajo los campos clave (prompt del cliente sin
    // resumen estructurado), completar con extractor IA sobre la conversación.
    const faltanClaves = ['producto', 'ciudad', 'direccion', 'precio'].some(
      (k) => !datosBot?.[k],
    );
    if (faltanClaves && api_key_openai) {
      datosBot = await completarDatosConIA({
        id_configuracion,
        id_cliente,
        datosBot,
        api_key_openai,
        paisNombre,
      });
      ctx.datos_bot = datosBot; // que el log refleje lo que realmente se usó
    }
    if (!datosBot.cantidad) datosBot.cantidad = '1';

    // 0.6 Candado de datos reales: si el bot cerró antes de tiempo, el resumen
    // trae relleno tipo "(pendiente)" / "(no proporcionado)" en vez de datos.
    // Mejor caer a orden manual que mandar basura a Dropi.
    const RELLENO =
      /pendiente|no proporcionad|falta|\[nombre|\[tel[eé]fono|\[direcci|tu n[uú]mero/i;
    for (const campo of ['nombre', 'telefono', 'direccion']) {
      if (RELLENO.test(String(datosBot[campo] || '')))
        return fail(
          'datos',
          `Campo ${campo} sin dato real: "${String(datosBot[campo]).slice(0, 80)}"`,
        );
    }
    const digitosTel = String(datosBot.telefono || '').replace(/\D/g, '');
    if (digitosTel.length < 9)
      return fail(
        'datos',
        `Teléfono inválido: "${String(datosBot.telefono || '').slice(0, 40)}"`,
      );

    // 1. Producto local con vínculo a Dropi (external_id)
    //    Cascada de identificación:
    //    a) Lo que el bot puso en el resumen (refleja la venta real)
    //    b) Headline del último anuncio CTWA (sistema referral: el dueño
    //       configura el headline = nombre EXACTO del producto)
    //    c) ultimo_producto_ad del cliente (respaldo del mismo sistema)
    const productos = await db.query(
      `SELECT id, nombre, precio, external_id, combos_producto
       FROM productos_chat_center
       WHERE id_configuracion = ? AND eliminado = 0
         AND external_source = 'DROPI' AND external_id IS NOT NULL`,
      { replacements: [id_configuracion], type: db.QueryTypes.SELECT },
    );

    // Si el front mandó un producto_id explícito (select del catálogo), se
    // usa directo — evita los errores del match por nombre.
    let prodLocal = null;
    let fuenteProducto = 'bot';
    const prodIdDirecto = Number(datosBot.producto_id) || null;
    if (prodIdDirecto) {
      prodLocal = productos.find((p) => Number(p.id) === prodIdDirecto) || null;
      if (prodLocal) fuenteProducto = 'producto_id (select)';
    }

    if (!prodLocal)
      prodLocal = matchEnLista(productos, datosBot.producto, (p) => p.nombre);

    if (!prodLocal) {
      // b) headline del último anuncio por el que entró este cliente
      const [ad] = await db.query(
        `SELECT headline FROM cliente_productos_ad
         WHERE id_cliente = ? AND id_configuracion = ?
         ORDER BY id DESC LIMIT 1`,
        {
          replacements: [id_cliente, id_configuracion],
          type: db.QueryTypes.SELECT,
        },
      );
      const headline = String(ad?.headline || '').trim();
      if (headline) {
        prodLocal = matchEnLista(productos, headline, (p) => p.nombre);
        if (prodLocal) fuenteProducto = `headline_ad ("${headline}")`;
      }
    }

    if (!prodLocal) {
      // c) respaldo: ultimo_producto_ad guardado en el cliente
      const [cli] = await db.query(
        `SELECT ultimo_producto_ad FROM clientes_chat_center WHERE id = ? LIMIT 1`,
        { replacements: [id_cliente], type: db.QueryTypes.SELECT },
      );
      const upa = String(cli?.ultimo_producto_ad || '').trim();
      if (upa) {
        prodLocal = matchEnLista(productos, upa, (p) => p.nombre);
        if (prodLocal) fuenteProducto = `ultimo_producto_ad ("${upa}")`;
      }
    }

    if (!prodLocal) {
      return fail(
        'producto',
        `Sin match para "${datosBot.producto}" (ni headline/producto_ad). Vinculados: ${productos.length}`,
      );
    }

    // 1.5 Cantidad → producto/combo a despachar
    const cantidad = Math.max(
      1,
      parseInt(String(datosBot.cantidad || '1').replace(/\D/g, ''), 10) || 1,
    );

    let dropiProductId = Number(prodLocal.external_id);
    let cantidadOrden = 1;
    let comboUsado = null;

    if (cantidad > 1) {
      let combos = [];
      try {
        combos = JSON.parse(prodLocal.combos_producto || '[]');
      } catch (_) {}
      comboUsado = (Array.isArray(combos) ? combos : []).find(
        (c) =>
          Number(c?.cantidad) === cantidad &&
          Number(c?.id_dropi || c?.external_id) > 0,
      );

      if (comboUsado) {
        // El combo ES otro producto en Dropi → se despacha 1 unidad de ese ID
        dropiProductId = Number(comboUsado.id_dropi || comboUsado.external_id);
        cantidadOrden = 1;
      } else {
        // Sin combo configurado → producto base x N (decisión del cliente)
        cantidadOrden = cantidad;
      }
    }

    // 2. Producto crudo desde POST /products/index — el MISMO endpoint que
    //    usa el flujo manual del front (GET_DROPI_PRODUCTS), probado en batalla.
    //    Buscamos por keywords y filtramos por id exacto.
    //    privated: false = catálogo público; true = productos privatizados
    //    para el cliente (los que estos dropshippers COD suelen vender).
    //    Va con reintento 429.
    const buscarEnIndex = async (
      keywords,
      pageSize,
      targetId = dropiProductId,
      privated = false,
    ) => {
      const resp = await conReintento429(() =>
        dropiService.listProductsIndex({
          integrationKey,
          payload: {
            pageSize,
            startData: 0,
            no_count: true,
            order_by: 'id',
            order_type: 'desc',
            keywords,
            favorite: false,
            privated_product: privated,
          },
          country_code,
        }),
      );
      const lista =
        resp?.objects || resp?.data?.objects || resp?.data?.products || [];
      return (Array.isArray(lista) ? lista : []).find(
        (p) => Number(p?.id) === Number(targetId),
      );
    };

    // Prueba catálogo público y, si no aparece, privado. Corta en el primer hit.
    const buscarEnIndexAmbos = async (
      keywords,
      pageSize,
      targetId = dropiProductId,
    ) =>
      (await buscarEnIndex(keywords, pageSize, targetId, false)) ||
      (await buscarEnIndex(keywords, pageSize, targetId, true));

    let prodDropi = null;

    // Intento 1: detalle directo por ID — GET /products/v2/:id.
    // Endpoint PROBADO en producción: el socket handler de cotización
    // (GET_DROPI_COTIZA_ENVIO_V2) lo usa para resolver warehouse_id.
    // Es la única forma confiable de traer un COMBO (otro ID con otro nombre).
    try {
      const det = await conReintento429(() =>
        dropiService.getProductDetail({
          integrationKey,
          productId: dropiProductId,
          country_code,
        }),
      );
      const obj = det?.objects || det?.data?.objects || det?.data || null;
      if (Number(obj?.id) === dropiProductId) prodDropi = obj;
    } catch (e) {
      // sigue al fallback por /products/index
    }

    // Intento 2/3: /products/index por keywords del nombre local,
    // luego sin keywords (página amplia). Ambos prueban público y privado.
    if (!prodDropi) {
      try {
        const kw =
          tokensSignificativos(prodLocal.nombre).slice(0, 3).join(' ') ||
          prodLocal.nombre;
        prodDropi = await buscarEnIndexAmbos(kw, 60);
        if (!prodDropi) prodDropi = await buscarEnIndexAmbos('', 100);
      } catch (e) {
        return fail(
          'producto_detalle',
          `listProductsIndex /products/index: ${e?.message || e} (status ${e?.statusCode || '?'})`,
        );
      }
    }

    if (!prodDropi?.id)
      return fail(
        'producto_detalle',
        `Producto #${dropiProductId} no apareció ni en /products/v2/:id ni en /products/index`,
      );
    /* Producto variable: hasta ahora se rechazaba en seco y la orden quedaba
       sin subir. Ahora se resuelve la variante que pidió el cliente:
         1) la que el bot capturó (datosBot.variedad / variacion),
         2) si no la dijo pero solo hay una con stock, esa,
         3) si hay varias y no eligió → manual, pero diciendo cuáles son
            para que el asesor la elija en el selector de pedidos. */
    const esVariable = String(prodDropi.type || 'SIMPLE') !== 'SIMPLE';
    // Variantes a despachar: lo normal es una sola con toda la cantidad, pero
    // "una negra y una café" es venta legítima → un renglón por variante,
    // igual que el selector manual del panel.
    let variacionesElegidas = []; // [{ id, etiqueta, stock, qty }]

    if (esVariable) {
      const variantes = (
        Array.isArray(prodDropi.variations) ? prodDropi.variations : []
      ).map((v) => {
        const attrs = Array.isArray(v.attribute_values) ? v.attribute_values : [];
        const etiqueta =
          attrs
            .map((a) => a?.value)
            .filter(Boolean)
            .join(' / ') ||
          v.sku ||
          `#${v.id}`;
        const stockBodegas = Array.isArray(v.warehouse_product_variation)
          ? v.warehouse_product_variation.reduce(
              (a, wpv) => a + (Number(wpv?.stock) || 0),
              0,
            )
          : 0;
        return {
          id: v.id,
          etiqueta,
          stock: Number(v.stock) > 0 ? Number(v.stock) : stockBodegas,
          sale_price: v.sale_price,
        };
      });

      if (!variantes.length) {
        return fail(
          'producto',
          `Producto #${dropiProductId} es ${prodDropi.type} pero Dropi no devolvió variantes`,
        );
      }

      let pedida = String(
        datosBot?.variedad ?? datosBot?.variacion ?? datosBot?.variante ?? '',
      )
        .trim()
        .toLowerCase();

      /* Si el resumen del bot no trajo la variedad, se relee la conversación
         con el extractor IA. Solo acá: para un producto simple sería un gasto
         inútil, pero en uno variable es la diferencia entre subir la orden o
         dejarla manual. */
      if (!pedida && api_key_openai && !datosBot?._fuente_ia) {
        datosBot = await completarDatosConIA({
          id_configuracion,
          id_cliente,
          datosBot,
          api_key_openai,
          paisNombre,
        });
        ctx.datos_bot = datosBot;
        pedida = String(datosBot?.variedad || '')
          .trim()
          .toLowerCase();
      }

      const conStock = variantes.filter((v) => v.stock >= cantidadOrden);

      if (pedida) {
        const unica =
          variantes.find((v) => v.etiqueta.toLowerCase() === pedida) ||
          variantes.find((v) => v.etiqueta.toLowerCase().includes(pedida)) ||
          null;
        if (unica) {
          variacionesElegidas = [{ ...unica, qty: cantidadOrden }];
        } else {
          /* El bot a veces adorna la línea ("Negro (2 unidades)") o el cliente
             pide varias ("Negro y Cafe"). Se busca qué etiquetas aparecen
             DENTRO del texto: una sola → esa con toda la cantidad; varias y
             coinciden con las unidades pedidas → una unidad de cada una;
             varias sin cómo repartirlas (ej. 3 unidades, 2 colores) → manual,
             el resumen no dice cuántas van de cada color. */
          const dentro = variantes.filter((v) =>
            pedida.includes(v.etiqueta.toLowerCase()),
          );
          if (dentro.length === 1) {
            variacionesElegidas = [{ ...dentro[0], qty: cantidadOrden }];
          } else if (dentro.length > 1 && dentro.length === cantidadOrden) {
            variacionesElegidas = dentro.map((v) => ({ ...v, qty: 1 }));
          } else if (dentro.length > 1) {
            return fail(
              'producto',
              `El pedido mezcla ${dentro.length} variedades (${dentro.map((v) => v.etiqueta).join(' y ')}) ` +
                `en ${cantidadOrden} unidad(es) y no se puede repartir solo. ` +
                `Opciones: ${variantes.map((v) => `${v.etiqueta} (stock ${v.stock})`).join(', ')}`,
            );
          }
        }
      }
      /* ── Candado anti-alucinación ──
         La variedad del resumen la escribe el BOT, y a veces la inventa
         ("Has elegido Negro" sin que el cliente lo dijera). Antes de confiar,
         se verifica que CADA etiqueta elegida aparezca en algún mensaje DEL
         CLIENTE. Si alguna no aparece, la orden cae a manual con las opciones
         listadas: mil veces mejor un pedido manual que uno del color
         equivocado. */
      if (variacionesElegidas.length) {
        const sinAcentos = (s) =>
          String(s || '')
            .toLowerCase()
            .normalize('NFD')
            .replace(/[̀-ͯ]/g, '');
        const msgsCliente = await db.query(
          `SELECT texto_mensaje FROM mensajes_clientes
            WHERE celular_recibe = ? AND id_configuracion = ?
              AND rol_mensaje = 0 AND deleted_at IS NULL
            ORDER BY id DESC LIMIT 30`,
          {
            replacements: [id_cliente, id_configuracion],
            type: db.QueryTypes.SELECT,
          },
        );
        const textoCliente = sinAcentos(
          msgsCliente.map((m) => m.texto_mensaje).join(' '),
        );
        for (const v of variacionesElegidas) {
          if (!textoCliente.includes(sinAcentos(v.etiqueta))) {
            return fail(
              'producto',
              `Variedad "${v.etiqueta}" no confirmada por el cliente ` +
                `(no aparece en sus mensajes; posible invento del bot). ` +
                `Opciones: ${variantes.map((x) => `${x.etiqueta} (stock ${x.stock})`).join(', ')}`,
            );
          }
        }
      }

      /* Única variante con stock como default SOLO cuando el cliente no
         nombró ninguna: si nombró y no se pudo resolver, jamás sustituirla
         en silencio por otra (eso despacha el color equivocado). */
      if (!variacionesElegidas.length && !pedida && conStock.length === 1)
        variacionesElegidas = [{ ...conStock[0], qty: cantidadOrden }];

      if (!variacionesElegidas.length) {
        return fail(
          'producto',
          `Producto #${dropiProductId} es variable y falta elegir la variedad. ` +
            `Opciones: ${variantes.map((v) => `${v.etiqueta} (stock ${v.stock})`).join(', ')}`,
        );
      }
      for (const v of variacionesElegidas) {
        if (v.stock < v.qty) {
          return fail(
            'producto',
            `Stock insuficiente de "${v.etiqueta}": ${v.stock} < ${v.qty}`,
          );
        }
      }
    }

    // En variables el stock ya se validó por variante elegida.
    if (!esVariable) {
      const stockDropi = Number(
        prodDropi.stock ?? prodDropi.warehouse_product?.[0]?.stock ?? NaN,
      );
      if (Number.isFinite(stockDropi) && stockDropi < cantidadOrden) {
        return fail(
          'producto',
          `Stock insuficiente #${dropiProductId}: ${stockDropi} < ${cantidadOrden}`,
        );
      }
    }

    // 2.5 🛡️ Cinturón de margen: precio del bot vs costo proveedor.
    // Si el total cobrado al cliente es MENOR que el costo proveedor del
    // despacho, el bot alucinó precio o el combo está mal mapeado → manual.
    const precioVenta = parsearPrecio(datosBot.precio);
    if (precioVenta <= 0)
      return fail('precio', `Precio inválido del bot: "${datosBot.precio}"`);

    const costoProveedor =
      Number(
        prodDropi.sale_price ?? prodDropi.variations?.[0]?.sale_price ?? 0,
      ) * cantidadOrden;
    if (costoProveedor > 0 && precioVenta < costoProveedor) {
      return fail(
        'precio',
        `Total bot $${precioVenta} < costo proveedor $${costoProveedor} ` +
          `(#${dropiProductId} x${cantidadOrden}). Posible precio alucinado o combo mal mapeado.`,
      );
    }

    // 3. Provincia → ciudad (catálogo Dropi) + cod_dane destino
    let statesResp;
    try {
      statesResp = await conReintento429(() =>
        dropiService.listStates({
          integrationKey,
          country_id: 1,
          country_code,
        }),
      );
    } catch (e) {
      return fail(
        'provincia',
        `listStates /department: ${e?.message || e} (status ${e?.statusCode || '?'})`,
      );
    }
    const states =
      statesResp?.objects ||
      statesResp?.data?.objects ||
      statesResp?.data ||
      [];
    const state = matchEnLista(
      states,
      datosBot.provincia,
      (x) => x.name || x.department || x.nombre,
    );
    if (!state)
      return fail('provincia', `Sin match provincia "${datosBot.provincia}"`);

    let citiesResp;
    try {
      citiesResp = await conReintento429(() =>
        dropiService.listCities({
          integrationKey,
          payload: {
            department_id: Number(state.id),
            rate_type: 'CON RECAUDO',
          },
          country_code,
        }),
      );
    } catch (e) {
      return fail(
        'ciudad',
        `listCities /trajectory/bycity (dep ${state.id}): ${e?.message || e} (status ${e?.statusCode || '?'})`,
      );
    }
    const cities =
      citiesResp?.objects?.cities ||
      citiesResp?.data?.objects?.cities ||
      citiesResp?.cities ||
      citiesResp?.data?.cities ||
      [];
    const city = matchEnLista(
      cities,
      datosBot.ciudad,
      (x) => x.name || x.city || x.nombre,
    );
    if (!city)
      return fail(
        'ciudad',
        `Sin match ciudad "${datosBot.ciudad}" en ${state.name || ''} (${cities.length} ciudades)`,
      );
    const destCodDane = String(
      city.cod_dane || city.codDane || city.code_dane || '',
    );
    if (!destCodDane)
      return fail('ciudad', `Ciudad "${city.name}" sin cod_dane`);

    // 4. Ciudad remitente (bodega de origen) — SIEMPRE por ID de producto.
    //
    //    Se le pregunta a Dropi con getOriginCityForCalculateShipping, el
    //    mismo endpoint y la misma secuencia que el flujo manual de cotizar
    //    una orden existente (controllers/dropi_integrations.controller.js →
    //    cotizarTransportadorasOrden).
    //
    //    Antes esto se reconstruía desde el producto crudo y, si venía sin
    //    city anidada, se rescataba buscando el producto por NOMBRE en
    //    /products/index. Esa búsqueda armaba frases que no existen en el
    //    nombre real (quitaba las stopwords de en medio: "Alarma para Motos"
    //    → "ALARMA MOTOS") y no encontraba nada, así que ventas legítimas
    //    morían con "sin warehouse city". El id ya lo teníamos desde el
    //    principio: no hay por qué buscar por texto.
    let remitCityObj = null;
    let fuenteRemitente = 'dropi_api';

    try {
      const origResp = await conReintento429(() =>
        dropiService.getOriginCityForShipping({
          integrationKey,
          productId: dropiProductId,
          // el type lo manda Dropi en el propio producto; si no vino, se
          // deduce de si el bot eligió variantes (igual criterio que el
          // payload de cotización de más abajo).
          productType:
            prodDropi?.type ||
            (variacionesElegidas.length ? 'VARIABLE' : 'SIMPLE'),
          destination: destCodDane,
          country_code,
        }),
      );
      const oc =
        origResp?.objects ||
        origResp?.data?.objects ||
        origResp?.data ||
        origResp;
      if (oc && (oc.cod_dane || oc.id)) {
        const deptOrigen = states.find(
          (s) => Number(s.id || s.department_id) === Number(oc.department_id),
        );
        remitCityObj = oc.department
          ? oc
          : {
              ...oc,
              department: deptOrigen ? buildDepartment(deptOrigen) : undefined,
            };
      }
    } catch (e) {
      console.log(
        `[AutoOrden] getOriginCityForShipping falló (producto ${dropiProductId}): ${e?.message || e}`,
      );
    }

    // Respaldo 1: la bodega embebida en el producto crudo, si Dropi la mandó
    // en el detalle. Es gratis (ya está en memoria) y evita el último recurso.
    if (!remitCityObj?.cod_dane) {
      const wCity = pickWarehouseCityFromProduct(prodDropi);
      if (wCity?.cod_dane) {
        remitCityObj = wCity;
        fuenteRemitente = 'producto';
      }
    }

    // Último recurso: cotizar como si la bodega estuviera en la misma ciudad
    // del destino — mismo criterio que cotizarTransportadorasOrden. Nunca
    // tumba la venta por no haber podido resolver el origen.
    if (!remitCityObj?.cod_dane) {
      remitCityObj = { ...city };
      fuenteRemitente = 'fallback_destino';
      console.log(
        `[AutoOrden] origen sin resolver para producto ${dropiProductId} → se cotiza desde la ciudad de destino (${city.name || ''})`,
      );
    }

    const remitCodDane = String(remitCityObj.cod_dane || '').trim();

    // 5. Cotizar transportadoras → la más barata disponible.
    //    Payload CALCADO del socket handler GET_DROPI_COTIZA_ENVIO_V2:
    //    Dropi espera ciudad_destino y ciudad_remitente como objetos de
    //    ciudad COMPLETOS (con department embebido) + warehouse {id}.

    // ciudad_destino: la ciudad de /trajectory/bycity + su department
    const ciudad_destino = {
      ...city,
      department:
        city.department || (state ? buildDepartment(state) : undefined),
    };

    // ciudad_remitente: si la bodega está en la misma ciudad, se reutiliza
    // el destino (mismo atajo del handler; también es el caso del último
    // recurso de arriba). Si no, se le embebe su department buscándolo en
    // states por department_id.
    let ciudad_remitente;
    if (remitCodDane === destCodDane) {
      ciudad_remitente = { ...ciudad_destino };
    } else {
      const deptRemit = states.find(
        (d) =>
          Number(d.id || d.department_id) ===
          Number(remitCityObj.department_id),
      );
      ciudad_remitente = {
        ...remitCityObj,
        department:
          remitCityObj.department ||
          (deptRemit ? buildDepartment(deptRemit) : undefined),
      };
    }

    const warehouseId = pickWarehouseIdFromProduct(prodDropi);

    let quoteResp;
    try {
      quoteResp = await conReintento429(() =>
        dropiService.cotizaEnvioTransportadora({
          integrationKey,
          payload: {
            EnvioConCobro: true,
            ciudad_destino,
            ciudad_remitente,
            products: [
              { id: dropiProductId, quantity: cantidadOrden, type: 'SIMPLE' },
            ],
            amount: precioVenta,
            ...(warehouseId ? { warehouse: { id: warehouseId } } : {}),
          },
          country_code,
        }),
      );
    } catch (e) {
      return fail(
        'cotizacion',
        `cotizaEnvioTransportadoraV2 ${remitCodDane}->${destCodDane}: ${e?.message || e} (status ${e?.statusCode || '?'})`,
      );
    }
    const quotes = quoteResp?.objects || quoteResp?.data?.objects || [];
    const validas = (Array.isArray(quotes) ? quotes : [])
      .filter((q) => Number(q?.objects?.precioEnvio) > 0)
      .sort(
        (a, b) => Number(a.objects.precioEnvio) - Number(b.objects.precioEnvio),
      );
    if (!validas.length)
      return fail(
        'cotizacion',
        `Sin transportadoras disponibles ${remitCodDane}→${destCodDane} | resp: ${JSON.stringify(quoteResp).slice(0, 400)}`,
      );

    // Por defecto: la más barata. Si el cliente pidió agencia/oficina
    // Servientrega (línea "Envío:" del resumen), forzamos esa transportadora;
    // si Servientrega NO está entre las cotizaciones de esa ruta, caemos a la
    // más barata para no bloquear la venta.
    let mejor = validas[0];
    if (esEnvioAgenciaServientrega(datosBot)) {
      const servi = validas.find((q) =>
        nombreTransportadora(q).includes('SERVIENTREGA'),
      );
      if (servi) {
        mejor = servi;
        console.log(
          `[AutoOrden] Envío a agencia Servientrega → forzando transportadora "${nombreTransportadora(servi)}"`,
        );
      } else {
        console.log(
          '[AutoOrden] Agencia Servientrega solicitada pero no cotizó Servientrega; usando la más barata (fallback)',
        );
      }
    }
    // réplica de pickDistributionCompanyFromQuote (front: utils/orderHelper.js)
    const distributionCompany =
      mejor?.distributionCompany?.id && mejor?.distributionCompany?.name
        ? {
            id: Number(mejor.distributionCompany.id),
            name: String(mejor.distributionCompany.name),
          }
        : {
            id:
              Number(
                mejor?.transportadora_id ?? mejor?.distribution_company_id ?? 0,
              ) || null,
            name: String(
              mejor?.transportadora ??
                mejor?.distribution_company?.name ??
                mejor?.name ??
                '',
            ).trim(),
          };
    if (!distributionCompany.id || !distributionCompany.name) {
      return fail(
        'cotizacion',
        `Quote sin id/name transportadora: ${JSON.stringify(mejor).slice(0, 300)}`,
      );
    }

    // 6. Precios coherentes: unitario redondeado y total = unitario * qty
    // (mismo criterio del front: total_order = suma de qty*price)
    const precioUnitario =
      Math.round((precioVenta / cantidadOrden) * 100) / 100;
    const totalOrder = Math.round(precioUnitario * cantidadOrden * 100) / 100;

    const [nombre, ...resto] = String(datosBot.nombre || '')
      .trim()
      .split(/\s+/);
    const surname = resto.join(' ') || nombre || 'Cliente';

    // Renglones de la orden. Se arman fuera del payload porque también
    // alimentan las variables de la plantilla de seguimiento ({{contenido}}).
    const productosOrden = (() => {
      const base = comboUsado
        ? `${prodLocal.nombre} (combo x${cantidad})`
        : prodLocal.nombre;
      if (!variacionesElegidas.length) {
        return [
          {
            id: dropiProductId,
            name: base,
            type: 'SIMPLE',
            variation_id: null,
            variations: [],
            quantity: cantidadOrden,
            price: precioUnitario,
            sale_price: null,
            suggested_price: null,
          },
        ];
      }
      // Un renglón por variante (igual que el selector manual del panel).
      // La variedad va en el nombre para que se lea en Dropi y en la
      // guía sin tener que abrir el detalle.
      return variacionesElegidas.map((v) => ({
        id: dropiProductId,
        name: `${base} — ${v.etiqueta}`,
        type: 'VARIABLE',
        variation_id: v.id,
        variations: [{ id: v.id, quantity: v.qty }],
        quantity: v.qty,
        price: precioUnitario,
        sale_price: null,
        suggested_price: null,
      }));
    })();

    const data = await createOrderForClient({
      id_configuracion,
      body: {
        status: 'PENDIENTE CONFIRMACION',
        type: 'FINAL_ORDER',
        type_service: 'normal',
        rate_type: 'CON RECAUDO',
        total_order: totalOrder,
        shipping_amount: 0,
        payment_method_id: 1,
        notes: '',
        name: nombre || 'Cliente',
        surname,
        phone: datosBot.telefono,
        client_email: '',
        state: state.name || state.department || state.nombre,
        city: city.name || city.city || city.nombre,
        dir: datosBot.direccion,
        zip_code: null,
        colonia: '',
        dni: '',
        dni_type: '',
        insurance: null,
        shalom_data: null,
        distributionCompany,
        products: productosOrden,
      },
    });

    const created = data?.objects ?? data?.order ?? data?.data ?? data;
    const orderId = Number(created?.id || data?.id) || null;

    // Enlace contacto origen ↔ orden: el notifier moverá TAMBIÉN a este contacto
    // (el que el bot capturó) por las columnas aunque la orden tenga otro
    // teléfono. Los mensajes siguen yendo solo al número de la orden.
    if (orderId && id_cliente) {
      await enlazarOrdenContactoOrigen({
        id_configuracion,
        dropi_order_id: orderId,
        id_cliente_origen: id_cliente,
        telefono_orden: datosBot.telefono,
      }).catch(() => {});
    }

    // Plantilla de seguimiento "PENDIENTE CONFIRMACION" para la venta que
    // cerró el bot. El service decide si corresponde (estado activo + gate
    // enviar_en_orden_bot del cliente) y NO mueve de columna: el contacto se
    // queda en generar_guia. Best-effort: nunca tumba la creación de la orden.
    if (orderId) {
      const resSeg = await enviarConfirmacionOrdenBot({
        id_configuracion,
        dropi_order_id: orderId,
        country_code,
        order: {
          id: orderId,
          name: nombre || 'Cliente',
          surname,
          phone: datosBot.telefono,
          dir: datosBot.direccion,
          city: city.name || city.city || city.nombre,
          state: state.name || state.department || state.nombre,
          total_order: totalOrder,
          orderdetails: productosOrden.map((p) => ({
            quantity: p.quantity,
            product: { name: p.name },
          })),
        },
      });
      if (!resSeg?.enviado && resSeg?.motivo) {
        console.log(
          `[AutoOrden] confirmación WhatsApp no enviada (orden ${orderId}): ${resSeg.motivo}`,
        );
      }
    }

    await logAuto({
      ...ctx,
      resultado: 'creada',
      dropi_order_id: orderId,
      detalle:
        `Transportadora: ${distributionCompany.name} ($${mejor?.objects?.precioEnvio}) | ` +
        `total: ${totalOrder} | qty: ${cantidad} | producto via ${fuenteProducto}` +
        // deja rastro de cómo se resolvió la bodega: si aparece
        // "fallback_destino" es que Dropi no devolvió el origen y se cotizó
        // desde la ciudad del cliente.
        (fuenteRemitente !== 'dropi_api'
          ? ` | origen via ${fuenteRemitente}`
          : '') +
        (comboUsado
          ? ` | COMBO #${dropiProductId}`
          : cantidadOrden > 1
            ? ` | base x${cantidadOrden}`
            : '') +
        (variacionesElegidas.length
          ? ` | var: ${variacionesElegidas.map((v) => `${v.etiqueta} x${v.qty}`).join(' + ')}`
          : '') +
        (datosBot._fuente_ia ? ' | datos via extractor IA' : ''),
    });

    return { orderId, data };
  } catch (err) {
    const url = err?.config?.url || '';
    const respData = err?.response?.data
      ? JSON.stringify(err.response.data).slice(0, 300)
      : '';
    await fail(
      'create',
      `${err?.message || String(err)}` +
        (url ? ` | url: ${url}` : '') +
        (respData ? ` | resp: ${respData}` : ''),
    );
    return null;
  }
}

/* ──────────────── actualización de orden existente ──────────────── */

/**
 * Actualiza una orden Dropi que YA existe cuando el cliente confirma su
 * pedido en la columna "Pendiente Confirmación" (es_dropi_principal). La
 * orden entró desde landing/Shopify en estado PENDIENTE CONFIRMACION; aquí
 * la pasamos a PENDIENTE (+ los datos que el cliente haya corregido).
 * Gate: configuraciones.auto_actualizar_orden_dropi = 1 (force lo salta).
 * Si NO se encuentra la orden en el cache, se deja como está (no crea nada).
 */
async function autoActualizarOrdenDropi({
  id_configuracion,
  id_cliente,
  telefono, // número del cliente, para localizar la orden en el cache
  cambios = {}, // solo los datos que el cliente pidió cambiar (opcional)
  force = false,
}) {
  const ctx = { id_configuracion, id_cliente, telefono, datos_bot: cambios };
  const fail = (paso, detalle) =>
    logAuto({ ...ctx, resultado: 'fallida', paso_fallo: paso, detalle });

  try {
    // 0. Gate por config
    if (!force) {
      const [cfg] = await db.query(
        `SELECT auto_actualizar_orden_dropi FROM configuraciones WHERE id = ? LIMIT 1`,
        { replacements: [id_configuracion], type: db.QueryTypes.SELECT },
      );
      if (!cfg || Number(cfg.auto_actualizar_orden_dropi) !== 1) return null;
    }

    // 1. Localizar la orden PENDIENTE CONFIRMACION del cliente en el cache Dropi
    const tel9 = String(telefono || '').replace(/\D/g, '').slice(-9);
    if (tel9.length < 9) return fail('telefono', 'Teléfono incompleto');

    const [orden] = await db.query(
      `SELECT dropi_order_id
         FROM dropi_orders_cache
        WHERE id_configuracion = ?
          AND RIGHT(REGEXP_REPLACE(phone, '[^0-9]', ''), 9) = ?
          AND UPPER(status) = 'PENDIENTE CONFIRMACION'
        ORDER BY order_created_at DESC
        LIMIT 1`,
      { replacements: [id_configuracion, tel9], type: db.QueryTypes.SELECT },
    );
    if (!orden?.dropi_order_id) {
      // Sin orden que actualizar → se queda en PENDIENTE CONFIRMACION.
      return logAuto({
        ...ctx,
        resultado: 'omitida',
        paso_fallo: 'sin_orden_existente',
        detalle: 'No hay orden PENDIENTE CONFIRMACION en el cache para el teléfono',
      });
    }

    // 2. status → PENDIENTE + SOLO los datos que el cliente cambió (si los hay).
    //    NO se toca provincia/state (el bot la deduce y ya viene bien en Dropi).
    const body = { status: 'PENDIENTE' };
    const set = (k, v) => {
      const s = String(v ?? '').trim();
      if (s) body[k] = s;
    };
    if (String(cambios.nombre || '').trim()) {
      const partes = String(cambios.nombre).trim().split(/\s+/);
      set('name', partes[0]);
      set('surname', partes.slice(1).join(' '));
    }
    set('phone', cambios.telefono);
    set('dir', cambios.direccion);
    set('city', cambios.ciudad);

    // 3. Actualizar en Dropi. Si el update con datos corregidos falla (p.ej.
    //    Dropi rechaza el teléfono), reintenta con solo status para no perder
    //    la confirmación de la orden.
    const orderId = orden.dropi_order_id;
    try {
      await updateOrderForClient({ id_configuracion, orderId, body });
    } catch (e1) {
      await updateOrderForClient({
        id_configuracion,
        orderId,
        body: { status: 'PENDIENTE' },
      });
    }

    return logAuto({
      ...ctx,
      resultado: 'actualizada',
      dropi_order_id: orderId,
      detalle: 'PENDIENTE CONFIRMACION → PENDIENTE',
    });
  } catch (e) {
    return fail('actualizar', e?.message || String(e));
  }
}

module.exports = {
  autoCrearOrdenDropi,
  autoActualizarOrdenDropi,
  matchEnLista,
};
