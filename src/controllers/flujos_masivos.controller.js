'use strict';

const { db } = require('../database/config');
const {
  resolverLugarRetiro,
  completarAgenciaEnBackground,
} = require('../utils/lugarRetiroAgencia');
const {
  mapaImagenesCatalogo,
  matchImagenPorNombre,
  urlDesdeUrlS3,
} = require('../utils/imagenProductoOrden');

/* ═══════════════════════════════════════════════════════════
   Flujos de envío masivo ("audiencia → mensaje → cuándo").

   La pieza que faltaba del masivo clásico: armar la audiencia por filtros
   (columna del kanban + "no ha respondido") y resolver los valores de la
   plantilla POR CONTACTO desde su orden real. La programación y el envío
   siguen siendo el pipeline de siempre (programarTemplateMasivo +
   template_envios_programados + su cron): aquí solo se calcula QUIÉN entra
   y CON QUÉ datos.
   ═══════════════════════════════════════════════════════════ */

/* Catálogo de variables que el flujo sabe resolver. La fuente gana en este
   orden: orden Dropi (cache del cron) → orden Shopify (webhook) → ficha del
   contacto. El front lo pinta tal cual; agregar una variable nueva es
   agregarla aquí y resolverla en resolverValores. */
const VARIABLES_FLUJO = [
  { key: 'nombre', label: 'Nombre' },
  { key: 'apellido', label: 'Apellido' },
  { key: 'nombre_completo', label: 'Nombre completo' },
  { key: 'producto', label: 'Producto(s) del pedido' },
  { key: 'total', label: 'Total del pedido' },
  { key: 'ciudad', label: 'Ciudad' },
  { key: 'provincia', label: 'Provincia' },
  { key: 'direccion', label: 'Dirección' },
  { key: 'numero_guia', label: 'Número de guía' },
  { key: 'transportadora', label: 'Transportadora' },
  { key: 'order_id', label: 'Número de orden' },
  { key: 'telefono', label: 'Teléfono' },
  /* Retiro en agencia: Dropi deja el DOMICILIO en `dir` cuando Servientrega
     desvía el paquete a una agencia (~35% de los casos). Esta variable usa
     utils/lugarRetiroAgencia: agencia real (caché BD/Servientrega) → `dir`
     solo si parece agencia → "agencia de Servientrega en {ciudad}". Nunca el
     domicilio del cliente. */
  { key: 'lugar_retiro', label: 'Lugar de retiro (agencia Servientrega)' },
  /* Para botones "Descargar guía" (cloudfront/{{1}}): la ruta del PDF. */
  { key: 'guia_pdf', label: 'PDF de la guía (botón Descargar)' },
];

const tel9 = (s) =>
  String(s || '')
    .replace(/\D/g, '')
    .slice(-9);

function resolverValores(contacto, ordenDropi, ordenShopify) {
  const dts = ordenShopify?.datos || {};
  const nombre =
    ordenDropi?.name || dts.nombre || contacto.nombre_cliente || '';
  const apellido =
    ordenDropi?.surname || dts.apellido || contacto.apellido_cliente || '';

  let producto = '';
  if (ordenDropi?.product_names) {
    try {
      const arr =
        typeof ordenDropi.product_names === 'string'
          ? JSON.parse(ordenDropi.product_names)
          : ordenDropi.product_names;
      if (Array.isArray(arr)) producto = arr.filter(Boolean).join(', ');
    } catch (_) {}
  }
  if (!producto) producto = dts.producto || '';

  return {
    nombre,
    apellido,
    nombre_completo: `${nombre} ${apellido}`.trim(),
    producto,
    total:
      ordenDropi?.total_order != null
        ? String(ordenDropi.total_order)
        : dts.total ||
          (ordenShopify?.total_price != null
            ? String(ordenShopify.total_price)
            : ''),
    ciudad: ordenDropi?.city || dts.ciudad || '',
    provincia: dts.provincia || '',
    direccion:
      dts.direccion || ordenDropi?.dir || contacto.direccion || '',
    numero_guia: ordenDropi?.shipping_guide || '',
    transportadora: ordenDropi?.shipping_company || '',
    order_id:
      ordenDropi?.dropi_order_id != null
        ? String(ordenDropi.dropi_order_id)
        : ordenShopify?.order_number != null
          ? String(ordenShopify.order_number)
          : '',
    telefono: String(contacto.celular_cliente || '').replace(/\D/g, ''),
  };
}

/**
 * POST /whatsapp_managment/flujos_audiencia
 * Body: {
 *   id_configuracion,
 *   estados: ['pendiente_confirmacion', ...],   ← columnas del kanban (estado_db)
 *   dias_atras: 30,                             ← ventana de actividad (1-90)
 *   solo_sin_respuesta: true,                   ← solo quien NO ha escrito...
 *   horas_sin_respuesta: 24,                    ← ...en las últimas N horas
 *                                                 (0 = nunca dentro de la ventana)
 *   limite: 1000                                ← tope de audiencia (1-2000)
 * }
 *
 * Devuelve los contactos que cumplen los filtros con los valores de plantilla
 * ya resueltos por contacto y de qué fuente salieron (dropi/shopify/contacto).
 * El front usa esto para el conteo en vivo, la vista previa y para armar el
 * parametros_por_cliente que se manda a programar_template_masivo.
 */
exports.previewAudiencia = async (req, res) => {
  try {
    const id_configuracion = Number(req.body?.id_configuracion || 0);
    const estados = (Array.isArray(req.body?.estados) ? req.body.estados : [])
      .map((e) => String(e || '').trim())
      .filter(Boolean)
      .slice(0, 20);

    if (!id_configuracion || !estados.length) {
      return res.status(400).json({
        ok: false,
        msg: 'id_configuracion y al menos un estado son requeridos',
      });
    }

    const dias = Math.min(Math.max(Number(req.body?.dias_atras) || 30, 1), 90);
    const soloSinRespuesta = !!req.body?.solo_sin_respuesta;
    const horas = Math.min(
      Math.max(Number(req.body?.horas_sin_respuesta) || 0, 0),
      dias * 24,
    );
    const limite = Math.min(
      Math.max(Number(req.body?.limite) || 1000, 1),
      2000,
    );

    /* La ventana por fecha no es decorativa: clientes_chat_center y
       mensajes_clientes son las tablas grandes del sistema; sin acotar por
       fecha esta consulta sería el próximo hotspot. "No ha respondido" =
       ningún mensaje DEL cliente (rol_mensaje = 0, celular_recibe = id del
       contacto) en las últimas N horas — con N = 0, en toda la ventana. */
    const repl = { cfg: id_configuracion, estados, dias, limite };
    let sqlSinResp = '';
    if (soloSinRespuesta) {
      if (horas > 0) repl.horas = horas;
      sqlSinResp = `AND NOT EXISTS (
            SELECT 1 FROM mensajes_clientes m
             WHERE m.celular_recibe = c.id
               AND m.id_configuracion = :cfg
               AND m.rol_mensaje = 0
               AND m.deleted_at IS NULL
               AND m.created_at > NOW() - INTERVAL ${horas > 0 ? ':horas HOUR' : ':dias DAY'})`;
    }

    const contactos = await db.query(
      `SELECT c.id, c.nombre_cliente, c.apellido_cliente, c.celular_cliente,
              c.direccion, c.estado_contacto, c.ultimo_mensaje_at
         FROM clientes_chat_center c
        WHERE c.id_configuracion = :cfg
          AND c.deleted_at IS NULL
          AND c.estado_contacto IN (:estados)
          AND COALESCE(c.ultimo_mensaje_at, c.created_at) > NOW() - INTERVAL :dias DAY
          ${sqlSinResp}
        ORDER BY COALESCE(c.ultimo_mensaje_at, c.created_at) DESC
        LIMIT :limite`,
      { replacements: repl, type: db.QueryTypes.SELECT },
    );

    // ── Órdenes por teléfono (últimos 9 dígitos), la más nueva gana ──
    const tels = [
      ...new Set(
        contactos.map((c) => tel9(c.celular_cliente)).filter((t) => t.length === 9),
      ),
    ];

    const dropiByTel = new Map();
    const shopiByTel = new Map();
    if (tels.length) {
      // dir y guia_urls3 viven dentro del JSON order_data (la tabla no los
      // tiene como columnas): dir alimenta la heurística de lugar de retiro
      // y guia_urls3 el botón "Descargar guía". JSON_VALID evita que una
      // fila vieja con JSON corrupto tumbe toda la consulta.
      const ordenes = await db.query(
        `SELECT dropi_order_id, name, surname, city, total_order, product_names,
                shipping_company, shipping_guide,
                CASE WHEN JSON_VALID(order_data)
                     THEN JSON_UNQUOTE(JSON_EXTRACT(order_data, '$.dir')) END AS dir,
                CASE WHEN JSON_VALID(order_data)
                     THEN JSON_UNQUOTE(JSON_EXTRACT(order_data, '$.guia_urls3')) END AS guia_urls3,
                CASE WHEN JSON_VALID(order_data)
                     THEN JSON_UNQUOTE(JSON_EXTRACT(order_data, '$.orderdetails[0].product_id')) END AS producto_dropi_id,
                CASE WHEN JSON_VALID(order_data)
                     THEN JSON_UNQUOTE(JSON_EXTRACT(order_data, '$.orderdetails[0].product.gallery[0].urlS3')) END AS producto_img_s3,
                RIGHT(REGEXP_REPLACE(COALESCE(phone,''),'[^0-9]',''),9) AS t9
           FROM dropi_orders_cache
          WHERE id_configuracion = :cfg
            AND created_at > NOW() - INTERVAL :dias DAY
          ORDER BY dropi_order_id DESC`,
        {
          replacements: { cfg: id_configuracion, dias },
          type: db.QueryTypes.SELECT,
        },
      );
      for (const o of ordenes) {
        if (o.t9 && !dropiByTel.has(o.t9)) {
          // JSON_UNQUOTE de un null JSON devuelve el string 'null'
          for (const k of ['dir', 'guia_urls3', 'producto_dropi_id', 'producto_img_s3']) {
            if (o[k] === 'null') o[k] = null;
          }
          dropiByTel.set(o.t9, o);
        }
      }

      const sordenes = await db.query(
        `SELECT order_number, total_price, datos_orden,
                RIGHT(REGEXP_REPLACE(COALESCE(phone_normalizado,''),'[^0-9]',''),9) AS t9
           FROM shopify_ordenes_webhook
          WHERE id_configuracion = :cfg
            AND shopify_created_at > NOW() - INTERVAL :dias DAY
            AND phone_normalizado IS NOT NULL
          ORDER BY id DESC`,
        {
          replacements: { cfg: id_configuracion, dias },
          type: db.QueryTypes.SELECT,
        },
      );
      for (const o of sordenes) {
        if (!o.t9 || shopiByTel.has(o.t9)) continue;
        let datos = null;
        try {
          datos =
            typeof o.datos_orden === 'string'
              ? JSON.parse(o.datos_orden)
              : o.datos_orden;
        } catch (_) {}
        shopiByTel.set(o.t9, { ...o, datos: datos || {} });
      }
    }

    const entradas = contactos.map((c) => {
      const t = tel9(c.celular_cliente);
      return {
        c,
        od: dropiByTel.get(t) || null,
        os: shopiByTel.get(t) || null,
        lugar_retiro: '',
      };
    });

    /* lugar_retiro SIN red (caché BD + heurística pareceAgencia): responde al
       instante y jamás devuelve el domicilio como lugar de retiro. Las
       agencias que aún no se conocen se completan en segundo plano vía el
       tracking de Servientrega (tope 25 por consulta para no inundarlo); el
       siguiente recálculo de la audiencia ya las trae de la caché. */
    let consultasBg = 0;
    const CHUNK = 25;
    for (let i = 0; i < entradas.length; i += CHUNK) {
      await Promise.all(
        entradas.slice(i, i + CHUNK).map(async (e) => {
          if (!e.od) return;
          const order = {
            id: e.od.dropi_order_id,
            dir: e.od.dir || '',
            city: e.od.city || '',
            shipping_guide: e.od.shipping_guide || '',
            shipping_company: e.od.shipping_company || '',
          };
          try {
            const r = await resolverLugarRetiro({ order, consultar: false });
            e.lugar_retiro = r?.lugar || '';
            if (
              r &&
              (r.fuente === 'ciudad' || r.fuente === 'transportadora') &&
              consultasBg < 25
            ) {
              consultasBg++;
              completarAgenciaEnBackground({ order });
            }
          } catch (_) {}
        }),
      );
    }

    /* Foto del producto por contacto (para plantillas con encabezado de
       imagen). El match va del más exacto al más laxo — el cliente tiene
       varios modelos parecidos y una foto equivocada es peor que ninguna:
       galería de la orden Dropi → catálogo por external_id → nombre solo si
       es inequívoco. Catálogo cargado UNA vez para todo el lote. */
    let catalogoImg = { porExternalId: new Map(), lista: [] };
    try {
      catalogoImg = await mapaImagenesCatalogo(id_configuracion);
    } catch (_) {}

    const imagenDe = (od, os) => {
      if (od) {
        const deOrden = urlDesdeUrlS3(od.producto_img_s3);
        if (deOrden) return { url: deOrden, fuente: 'orden_dropi' };
        if (od.producto_dropi_id) {
          const porId = catalogoImg.porExternalId.get(
            String(od.producto_dropi_id),
          );
          if (porId) return { url: porId, fuente: 'catalogo_id' };
        }
        let nombreProd = '';
        try {
          const arr =
            typeof od.product_names === 'string'
              ? JSON.parse(od.product_names)
              : od.product_names;
          nombreProd = Array.isArray(arr) ? arr[0] || '' : '';
        } catch (_) {}
        const porNombre = matchImagenPorNombre(catalogoImg.lista, nombreProd);
        if (porNombre) return { url: porNombre, fuente: 'catalogo_nombre' };
        return null;
      }
      if (os) {
        const porNombre = matchImagenPorNombre(
          catalogoImg.lista,
          os.datos?.producto || '',
        );
        if (porNombre) return { url: porNombre, fuente: 'catalogo_nombre' };
      }
      return null;
    };

    const CF_PREFIX = 'https://d39ru7awumhhs2.cloudfront.net/';
    const data = entradas.map(({ c, od, os, lugar_retiro }) => {
      const valores = resolverValores(c, od, os);
      valores.lugar_retiro = lugar_retiro || '';
      const g = String(od?.guia_urls3 || '');
      valores.guia_pdf = g.startsWith(CF_PREFIX)
        ? g.slice(CF_PREFIX.length)
        : g;
      const img = imagenDe(od, os);
      return {
        id: c.id,
        nombre:
          `${c.nombre_cliente || ''} ${c.apellido_cliente || ''}`.trim() ||
          'Sin nombre',
        telefono: c.celular_cliente,
        estado_contacto: c.estado_contacto,
        ultimo_mensaje_at: c.ultimo_mensaje_at,
        fuente: od ? 'dropi' : os ? 'shopify' : 'contacto',
        imagen_producto: img?.url || null,
        imagen_fuente: img?.fuente || null,
        valores,
      };
    });

    return res.json({
      ok: true,
      total: data.length,
      con_orden: data.filter((d) => d.fuente !== 'contacto').length,
      limite,
      variables: VARIABLES_FLUJO,
      data,
    });
  } catch (err) {
    return res.status(500).json({ ok: false, msg: err?.message });
  }
};
