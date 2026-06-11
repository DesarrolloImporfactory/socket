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
// ⚠️ Verifica que el nombre del archivo coincida con tu services/dropiOrders.service.js
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

function matchEnLista(lista, objetivo, pickName) {
  const target = normalizarTexto(objetivo);
  if (!target) return null;
  let found = lista.find((x) => normalizarTexto(pickName(x)) === target);
  if (found) return found;
  found = lista.find((x) => {
    const n = normalizarTexto(pickName(x));
    return n.includes(target) || target.includes(n);
  });
  return found || null;
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
    const productos = await db.query(
      `SELECT id, nombre, precio, external_id, combos_producto
       FROM productos_chat_center
       WHERE id_configuracion = ? AND eliminado = 0
         AND external_source = 'DROPI' AND external_id IS NOT NULL`,
      { replacements: [id_configuracion], type: db.QueryTypes.SELECT },
    );
    const prodLocal = matchEnLista(
      productos,
      datosBot.producto,
      (p) => p.nombre,
    );
    if (!prodLocal) {
      return fail(
        'producto',
        `Sin match para "${datosBot.producto}". Vinculados: ${productos.length}`,
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

    // 2. Detalle del producto a despachar en Dropi
    const prodDetail = await dropiService.getProductDetail({
      integrationKey,
      productId: dropiProductId,
      country_code,
    });
    const prodDropi =
      prodDetail?.objects ||
      prodDetail?.data?.objects ||
      prodDetail?.data ||
      null;
    if (!prodDropi?.id)
      return fail(
        'producto',
        `getProductDetail sin datos para #${dropiProductId}`,
      );
    if (String(prodDropi.type || 'SIMPLE') !== 'SIMPLE') {
      return fail(
        'producto',
        `Producto #${dropiProductId} es ${prodDropi.type}; auto-orden solo soporta SIMPLE`,
      );
    }
    if (
      prodDropi.stock !== undefined &&
      Number(prodDropi.stock) < cantidadOrden
    ) {
      return fail(
        'producto',
        `Stock insuficiente #${dropiProductId}: ${prodDropi.stock} < ${cantidadOrden}`,
      );
    }

    // 2.5 🛡️ Cinturón de margen: precio del bot vs costo proveedor.
    // Si el total cobrado al cliente es MENOR que el costo proveedor del
    // despacho, el bot alucinó precio o el combo está mal mapeado → manual.
    const precioVenta = parsearPrecio(datosBot.precio);
    if (precioVenta <= 0)
      return fail('precio', `Precio inválido del bot: "${datosBot.precio}"`);

    const costoProveedor = Number(prodDropi.sale_price || 0) * cantidadOrden;
    if (costoProveedor > 0 && precioVenta < costoProveedor) {
      return fail(
        'precio',
        `Total bot $${precioVenta} < costo proveedor $${costoProveedor} ` +
          `(#${dropiProductId} x${cantidadOrden}). Posible precio alucinado o combo mal mapeado.`,
      );
    }

    // 3. Provincia → ciudad (catálogo Dropi) + cod_dane destino
    const statesResp = await dropiService.listStates({
      integrationKey,
      country_id: 1,
      country_code,
    });
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

    const citiesResp = await dropiService.listCities({
      integrationKey,
      payload: { department_id: Number(state.id), rate_type: 'CON RECAUDO' },
      country_code,
    });
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

    // 4. Ciudad remitente (bodega del producto a despachar)
    const originResp = await dropiService.getOriginCityForShipping({
      integrationKey,
      productId: dropiProductId,
      productType: 'SIMPLE',
      destination: destCodDane,
      country_code,
    });
    const origin =
      originResp?.objects ||
      originResp?.data?.objects ||
      originResp?.data ||
      originResp;
    const remitCodDane = String(
      origin?.cod_dane ||
        origin?.codDane ||
        origin?.city?.cod_dane ||
        origin?.origin_cod_dane ||
        '',
    );
    if (!remitCodDane) {
      return fail(
        'remitente',
        `Sin cod_dane remitente. Respuesta: ${JSON.stringify(origin).slice(0, 300)}`,
      );
    }

    // 5. Cotizar transportadoras → la más barata disponible
    const quoteResp = await dropiService.cotizaEnvioTransportadora({
      integrationKey,
      payload: {
        EnvioConCobro: true,
        ciudad_destino_cod_dane: destCodDane,
        ciudad_remitente_cod_dane: remitCodDane,
        products: [
          { id: dropiProductId, quantity: cantidadOrden, type: 'SIMPLE' },
        ],
        amount: precioVenta,
      },
      country_code,
    });
    const quotes = quoteResp?.objects || quoteResp?.data?.objects || [];
    const validas = (Array.isArray(quotes) ? quotes : [])
      .filter((q) => Number(q?.objects?.precioEnvio) > 0)
      .sort(
        (a, b) => Number(a.objects.precioEnvio) - Number(b.objects.precioEnvio),
      );
    if (!validas.length)
      return fail(
        'cotizacion',
        `Sin transportadoras disponibles ${remitCodDane}→${destCodDane}`,
      );

    const mejor = validas[0];
    const distributionCompany = {
      id: Number(mejor.transportadora_id ?? mejor?.objects?.transportadora_id),
      name: String(
        mejor.transportadora ??
          mejor?.objects?.transportadora ??
          mejor?.name ??
          '',
      ),
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
        `total: ${totalOrder} | qty: ${cantidad}` +
        (comboUsado
          ? ` | COMBO #${dropiProductId}`
          : cantidadOrden > 1
            ? ` | base x${cantidadOrden}`
            : '') +
        (datosBot._fuente_ia ? ' | datos via extractor IA' : ''),
    });

    return { orderId, data };
  } catch (err) {
    await fail('create', err?.message || String(err));
    return null;
  }
}

module.exports = { autoCrearOrdenDropi };
