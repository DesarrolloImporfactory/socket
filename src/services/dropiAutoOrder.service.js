'use strict';

/**
 * Auto-creación de órdenes Dropi cuando el bot confirma la venta
 * (trigger [generar_guia]:true → columna generar_guia en Kanban IA).
 *
 * Best-effort: si CUALQUIER paso falla, loguea en dropi_auto_ordenes_log
 * y el flujo manual sigue como siempre.
 * Gate: configuraciones.auto_crear_orden_dropi = 1.
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
 */

const axios = require('axios');
const { db } = require('../database/config');
const { decryptToken } = require('../utils/cryptoToken');
const dropiService = require('./dropi.service');
const DropiIntegrations = require('../models/dropi_integrations.model');
const { createOrderForClient } = require('./dropiOrders.service');

/* ────────────────────────── helpers ────────────────────────── */

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
 * Réplica backend de pickRemitCodDaneFromProduct (front: utils/orderHelper.js).
 * Extrae el cod_dane de la bodega remitente desde el producto crudo
 * de /products/index. SIMPLE primero, fallback a variations.
 */
function pickRemitCodDaneFromProduct(rawProduct) {
  if (!rawProduct) return '';
  const cod = rawProduct?.warehouse_product?.[0]?.warehouse?.city?.cod_dane;
  if (cod) return String(cod).trim();
  if (Array.isArray(rawProduct?.variations)) {
    for (const v of rawProduct.variations) {
      if (Array.isArray(v?.warehouse_product_variation)) {
        for (const wpv of v.warehouse_product_variation) {
          const c = wpv?.warehouse?.city?.cod_dane;
          if (c) return String(c).trim();
        }
      }
    }
  }
  return '';
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
  const c = rawProduct?.warehouse_product?.[0]?.warehouse?.city;
  if (c) return c;
  if (Array.isArray(rawProduct?.variations)) {
    for (const v of rawProduct.variations) {
      for (const wpv of v?.warehouse_product_variation || []) {
        if (wpv?.warehouse?.city) return wpv.warehouse.city;
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
  return (
    Number(
      rawProduct?.warehouse_product?.[0]?.warehouse_id ||
        rawProduct?.warehouse_product?.[0]?.warehouse?.id ||
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
              'Extrae los datos del pedido confirmado de esta conversación de ventas COD en Ecuador. ' +
              'Responde SOLO un JSON con claves: nombre, telefono, provincia, ciudad, direccion, producto, precio_total, cantidad. ' +
              'producto = nombre del producto tal como lo menciona el VENDEDOR. ' +
              'precio_total = número, el total que el cliente acordó pagar. ' +
              'cantidad = número de unidades (1 si no se especifica). ' +
              'provincia = provincia de Ecuador a la que pertenece la ciudad. ' +
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
    // 0. Gate por config
    const [cfg] = await db.query(
      `SELECT auto_crear_orden_dropi FROM configuraciones WHERE id = ? LIMIT 1`,
      { replacements: [id_configuracion], type: db.QueryTypes.SELECT },
    );
    if (!cfg || Number(cfg.auto_crear_orden_dropi) !== 1) return null;

    const integration = await DropiIntegrations.findOne({
      where: { id_configuracion, deleted_at: null, is_active: 1 },
      order: [['id', 'DESC']],
    });
    if (!integration) return fail('producto', 'Sin integración Dropi activa');

    const integrationKey = decryptToken(integration.integration_key_enc);
    const country_code = integration.country_code;

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
      });
      ctx.datos_bot = datosBot; // que el log refleje lo que realmente se usó
    }
    if (!datosBot.cantidad) datosBot.cantidad = '1';

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

    let prodLocal = matchEnLista(productos, datosBot.producto, (p) => p.nombre);
    let fuenteProducto = 'bot';

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
    const buscarEnIndex = async (keywords, pageSize) => {
      const resp = await dropiService.listProductsIndex({
        integrationKey,
        payload: {
          pageSize,
          startData: 0,
          no_count: true,
          order_by: 'id',
          order_type: 'desc',
          keywords,
          favorite: false,
          privated_product: false,
        },
        country_code,
      });
      const lista =
        resp?.objects || resp?.data?.objects || resp?.data?.products || [];
      return (Array.isArray(lista) ? lista : []).find(
        (p) => Number(p?.id) === dropiProductId,
      );
    };

    let prodDropi = null;

    // Intento 1: detalle directo por ID — GET /products/v2/:id.
    // Endpoint PROBADO en producción: el socket handler de cotización
    // (GET_DROPI_COTIZA_ENVIO_V2) lo usa para resolver warehouse_id.
    // Es la única forma confiable de traer un COMBO (otro ID con otro nombre).
    try {
      const det = await dropiService.getProductDetail({
        integrationKey,
        productId: dropiProductId,
        country_code,
      });
      const obj = det?.objects || det?.data?.objects || det?.data || null;
      if (Number(obj?.id) === dropiProductId) prodDropi = obj;
    } catch (e) {
      // sigue al fallback por /products/index
    }

    // Intento 2/3: /products/index por keywords del nombre local,
    // luego sin keywords (página amplia).
    if (!prodDropi) {
      try {
        const kw =
          tokensSignificativos(prodLocal.nombre).slice(0, 3).join(' ') ||
          prodLocal.nombre;
        prodDropi = await buscarEnIndex(kw, 60);
        if (!prodDropi) prodDropi = await buscarEnIndex('', 100);
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
    if (String(prodDropi.type || 'SIMPLE') !== 'SIMPLE') {
      return fail(
        'producto',
        `Producto #${dropiProductId} es ${prodDropi.type}; auto-orden solo soporta SIMPLE`,
      );
    }

    const stockDropi = Number(
      prodDropi.stock ?? prodDropi.warehouse_product?.[0]?.stock ?? NaN,
    );
    if (Number.isFinite(stockDropi) && stockDropi < cantidadOrden) {
      return fail(
        'producto',
        `Stock insuficiente #${dropiProductId}: ${stockDropi} < ${cantidadOrden}`,
      );
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
      statesResp = await dropiService.listStates({
        integrationKey,
        country_id: 1,
        country_code,
      });
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
      citiesResp = await dropiService.listCities({
        integrationKey,
        payload: { department_id: Number(state.id), rate_type: 'CON RECAUDO' },
        country_code,
      });
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

    // 4. Ciudad remitente: directo del producto crudo, igual que el front
    //    (pickRemitCodDaneFromProduct en utils/orderHelper.js).
    const remitCodDane = pickRemitCodDaneFromProduct(prodDropi);
    if (!remitCodDane) {
      return fail(
        'remitente',
        `Producto #${dropiProductId} sin warehouse_product[].warehouse.city.cod_dane en /products/index`,
      );
    }

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
    // el destino (mismo atajo del handler). Si no, sale del producto crudo
    // y se le embebe su department buscándolo en states por department_id.
    let ciudad_remitente;
    if (remitCodDane === destCodDane) {
      ciudad_remitente = { ...ciudad_destino };
    } else {
      const remitCityRaw = pickWarehouseCityFromProduct(prodDropi);
      if (!remitCityRaw) {
        return fail(
          'remitente',
          `Producto #${dropiProductId} sin objeto warehouse.city para armar ciudad_remitente`,
        );
      }
      const deptRemit = states.find(
        (d) =>
          Number(d.id || d.department_id) ===
          Number(remitCityRaw.department_id),
      );
      ciudad_remitente = {
        ...remitCityRaw,
        department:
          remitCityRaw.department ||
          (deptRemit ? buildDepartment(deptRemit) : undefined),
      };
    }

    const warehouseId = pickWarehouseIdFromProduct(prodDropi);

    let quoteResp;
    try {
      quoteResp = await dropiService.cotizaEnvioTransportadora({
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
      });
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

    const mejor = validas[0];
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
        notes: `🤖 Orden generada automáticamente por IA (pedido confirmado en chat). Qty solicitada: ${cantidad}${comboUsado ? ` | combo Dropi #${dropiProductId}` : ''}`,
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
        products: [
          {
            id: dropiProductId,
            name: comboUsado
              ? `${prodLocal.nombre} (combo x${cantidad})`
              : prodLocal.nombre,
            type: 'SIMPLE',
            variation_id: null,
            variations: [],
            quantity: cantidadOrden,
            price: precioUnitario,
            sale_price: null,
            suggested_price: null,
          },
        ],
      },
    });

    const created = data?.objects ?? data?.order ?? data?.data ?? data;
    const orderId = Number(created?.id || data?.id) || null;

    await logAuto({
      ...ctx,
      resultado: 'creada',
      dropi_order_id: orderId,
      detalle:
        `Transportadora: ${distributionCompany.name} ($${mejor?.objects?.precioEnvio}) | ` +
        `total: ${totalOrder} | qty: ${cantidad} | producto via ${fuenteProducto}` +
        (comboUsado
          ? ` | COMBO #${dropiProductId}`
          : cantidadOrden > 1
            ? ` | base x${cantidadOrden}`
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

module.exports = { autoCrearOrdenDropi };
